import OpenAI from "openai";
import { buildContextualPrompt } from "./companion-persona";
import { createPersonalSupabaseAdmin, Idea, CompanionMessage } from "./supabase-personal";

let _openai: OpenAI | null = null;
function openai(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ── INTENT DETECTION ──────────────────────────────────────────
// Determines what Brandon wants without hard-coded triggers

export interface CompanionIntent {
  type:
    | "capture_idea"        // new idea, goal, thought
    | "status_update"       // done, parked, abandoned, in progress
    | "reminder_setting"    // set/change reminder frequency
    | "retrieve_ideas"      // show me my ideas, what did I have about X
    | "research_request"    // look up, research, find out about
    | "draft_request"       // write me, draft, create
    | "question"            // general question needing an answer
    | "action_breakdown"    // break this down, what are the steps
    | "weekly_summary"      // what did I work on, summarize my week
    | "casual"              // greeting, small talk, quick chat
    | "voice_note"          // transcribed voice message
    | "other";              // AI handles freely
  confidence: "high" | "medium" | "low";
  extractedData: {
    ideaTitle?: string;
    category?: string;
    priority?: string;
    dueDate?: string;
    reminderFrequency?: number;
    searchQuery?: string;
    researchTopic?: string;
    statusChange?: string;
    ideaReference?: string;
  };
}

export async function detectIntent(
  message: string
): Promise<CompanionIntent> {
  try {
    const response = await openai().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Analyze this message from Brandon and return JSON only.
Determine the primary intent and extract any relevant data.

Return:
{
  "type": "capture_idea|status_update|reminder_setting|retrieve_ideas|research_request|draft_request|question|action_breakdown|weekly_summary|casual|other",
  "confidence": "high|medium|low",
  "extractedData": {
    "ideaTitle": "short title for the idea if capturing",
    "category": "Business|Content|Product|Operations|Personal|Research|Finance|Marketing|Technology|Other|General",
    "priority": "High|Medium|Low",
    "dueDate": "ISO date if mentioned",
    "reminderFrequency": number of hours if mentioned,
    "searchQuery": "search terms if research requested",
    "researchTopic": "what to research",
    "statusChange": "Done|Parked|Abandoned|In Progress if status being changed",
    "ideaReference": "which idea they're referring to if retrieving or updating"
  }
}`,
        },
        { role: "user", content: message },
      ],
      max_tokens: 300,
      temperature: 0,
      response_format: { type: "json_object" },
    });

    return JSON.parse(
      response.choices[0]?.message?.content ?? "{}"
    ) as CompanionIntent;
  } catch {
    return {
      type: "other",
      confidence: "low",
      extractedData: {},
    };
  }
}

// ── MAIN AI RESPONSE GENERATOR ────────────────────────────────

export async function generateCompanionResponse(options: {
  message: string;
  threadTs?: string;
  recentMessages?: CompanionMessage[];
  relevantIdeas?: Idea[];
  isVoice?: boolean;
}): Promise<{
  response: string;
  intent: CompanionIntent;
  tokensUsed: number;
}> {
  const { message, recentMessages = [], relevantIdeas = [], isVoice } = options;

  const intent = await detectIntent(message);

  const messages = buildContextualPrompt({
    recentMessages: recentMessages.map(m => ({
      role: m.role,
      content: m.content,
    })),
    relevantIdeas: (relevantIdeas ?? []).map(i => ({
      title: i.title,
      category: i.category,
      status: i.status,
      summary: i.summary,
    })),
    currentMessage: message,
    isVoice,
  });

  const response = await openai().chat.completions.create({
    model: "gpt-4o",
    messages,
    max_tokens: isVoice ? 200 : 1000,
    temperature: 0.7,
  });

  return {
    response: response.choices[0]?.message?.content?.trim() ?? "I didn't catch that. Could you repeat?",
    intent,
    tokensUsed: response.usage?.total_tokens ?? 0,
  };
}

// ── IDEA TITLE AND SUMMARY GENERATOR ─────────────────────────

export async function generateIdeaMetadata(rawInput: string): Promise<{
  title: string;
  summary: string;
  actionSteps: string[];
  category: string;
  priority: string;
}> {
  try {
    const response = await openai().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Extract structured metadata from this idea or thought.
Return JSON only:
{
  "title": "concise 3-7 word title",
  "summary": "1-2 sentence clear summary of the idea",
  "actionSteps": ["step 1", "step 2", "step 3"],
  "category": "Business|Content|Product|Operations|Personal|Research|Finance|Marketing|Technology|Other|General",
  "priority": "High|Medium|Low"
}`,
        },
        { role: "user", content: rawInput },
      ],
      max_tokens: 400,
      temperature: 0,
      response_format: { type: "json_object" },
    });

    return JSON.parse(response.choices[0]?.message?.content ?? "{}");
  } catch {
    return {
      title: rawInput.slice(0, 50),
      summary: rawInput,
      actionSteps: [],
      category: "General",
      priority: "Medium",
    };
  }
}

// ── CONTEXT LOADER ────────────────────────────────────────────
// Loads recent messages and relevant ideas for context

export async function loadConversationContext(threadTs?: string): Promise<{
  recentMessages: CompanionMessage[];
  relevantIdeas: Idea[];
}> {
  const supabase = createPersonalSupabaseAdmin();

  let msgQuery = supabase
    .from("companion_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);

  if (threadTs) {
    msgQuery = msgQuery.eq("thread_ts", threadTs);
  }

  const { data: messages } = await msgQuery;

  const { data: ideas } = await supabase
    .from("ideas")
    .select("id, title, category, status, summary")
    .in("status", ["Active", "In Progress"])
    .order("updated_at", { ascending: false })
    .limit(10);

  return {
    recentMessages: (messages ?? []).reverse() as CompanionMessage[],
    relevantIdeas: (ideas ?? []) as Idea[],
  };
}

// ── VOICE TRANSCRIPTION ───────────────────────────────────────

export async function transcribeAudio(
  audioBuffer: Buffer,
  fileName: string
): Promise<string | null> {
  try {
    const file = new File([audioBuffer as unknown as BlobPart], fileName, {
      type: fileName.endsWith(".webm") ? "audio/webm"
        : fileName.endsWith(".mp4") ? "audio/mp4"
        : fileName.endsWith(".ogg") ? "audio/ogg"
        : "audio/mpeg",
    });

    const transcription = await openai().audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "en",
    });

    return transcription.text?.trim() ?? null;
  } catch (err) {
    console.error("[whisper] transcription failed:", err);
    return null;
  }
}
