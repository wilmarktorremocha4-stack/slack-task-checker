import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  verifySlackSignature,
  postToThread,
  downloadFile,
  getBotId,
} from "@/lib/companion-slack";
import { createPersonalSupabaseAdmin } from "@/lib/supabase-personal";
import {
  generateCompanionResponse,
  detectIntent,
  transcribeAudio,
  loadConversationContext,
} from "@/lib/companion-ai";
import {
  createIdea,
  updateIdeaStatus,
  searchIdeas,
  getIdeas,
} from "@/lib/idea-manager";
import { conductResearch } from "@/lib/research-engine";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const rawBody = await request.text();

  const isValid = await verifySlackSignature(request, rawBody);
  if (!isValid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = JSON.parse(rawBody);

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  const event = body.event;
  if (!event) return NextResponse.json({ ok: true });

  console.log("[companion] event:", event.type);

  waitUntil(
    processEvent(event).catch(err =>
      console.error("[companion] error:", err)
    )
  );

  return NextResponse.json({ ok: true });
}

async function processEvent(event: Record<string, unknown>) {
  const supabase = createPersonalSupabaseAdmin();
  const channelId = process.env.SLACK_CHANNEL_ID!;
  const brandonId = process.env.SLACK_BRANDON_USER_ID!;
  const botId = await getBotId();

  // Ignore bot's own messages
  if (event.bot_id || event.user === botId) return;

  // Only process Brandon's messages
  if (event.user !== brandonId) return;

  const messageTs = event.ts as string;
  const threadTs = (event.thread_ts as string) || messageTs;

  // ── VOICE/AUDIO FILE ─────────────────────────────────────────
  if (
    event.type === "message" &&
    event.files &&
    Array.isArray(event.files) &&
    !event.thread_ts
  ) {
    const files = event.files as Array<Record<string, unknown>>;
    const audioFile = files.find(f => {
      const mime = (f.mimetype as string) ?? "";
      const ftype = (f.filetype as string) ?? "";
      return (
        mime.startsWith("audio/") ||
        ["mp4", "webm", "ogg", "m4a", "mp3"].includes(ftype)
      );
    });

    if (audioFile) {
      await handleVoiceInput(event, audioFile, channelId, messageTs, supabase);
      return;
    }
  }

  // ── TEXT MESSAGE (app mention or DM) ─────────────────────────
  if (
    (event.type === "app_mention" || event.type === "message") &&
    event.channel === channelId &&
    !event.bot_id
  ) {
    const rawText = (event.text as string) ?? "";
    const cleanText = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();

    if (!cleanText) return;

    await handleTextInput(
      cleanText,
      channelId,
      messageTs,
      threadTs,
      supabase,
      brandonId
    );
    return;
  }
}

async function handleTextInput(
  text: string,
  channelId: string,
  messageTs: string,
  threadTs: string,
  supabase: ReturnType<typeof createPersonalSupabaseAdmin>,
  _brandonId: string
) {
  const context = await loadConversationContext(threadTs);
  const intent = await detectIntent(text);

  // ── RETRIEVE IDEAS ─────────────────────────────────────────
  if (intent.type === "retrieve_ideas") {
    const query = intent.extractedData.searchQuery ?? text;
    const ideas = await searchIdeas(query);

    let responseText = "";
    if (ideas.length === 0) {
      responseText = `Nothing matching "${query}" in your records, Brandon. Want me to start tracking something related?`;
    } else {
      responseText = `Found ${ideas.length} matching idea${ideas.length > 1 ? "s" : ""}:\n\n${ideas
        .slice(0, 5)
        .map(i => `• *${i.title}* — ${i.status} (${i.category})${i.summary ? `\n  ${i.summary.slice(0, 100)}` : ""}`)
        .join("\n\n")}${ideas.length > 5 ? `\n\n...and ${ideas.length - 5} more. Check the dashboard for the full list.` : ""}`;
    }

    await postToThread(channelId, threadTs, responseText);

    await supabase.from("companion_messages").insert([
      { role: "user", content: text, channel_id: channelId, thread_ts: threadTs },
      { role: "assistant", content: responseText, channel_id: channelId, thread_ts: threadTs },
    ]);
    return;
  }

  // ── RESEARCH REQUEST ───────────────────────────────────────
  if (intent.type === "research_request") {
    const topic = intent.extractedData.researchTopic ?? text;
    await postToThread(channelId, threadTs, `Researching "${topic}" now. Give me a moment.`);

    const results = await conductResearch(topic);
    await postToThread(channelId, threadTs, results);

    await supabase.from("companion_messages").insert([
      { role: "user", content: text, channel_id: channelId, thread_ts: threadTs },
      { role: "assistant", content: results, channel_id: channelId, thread_ts: threadTs },
    ]);
    return;
  }

  // ── STATUS UPDATE ─────────────────────────────────────────
  if (intent.type === "status_update" && intent.extractedData.statusChange) {
    const activeIdeas = await getIdeas({ status: "Active", limit: 1 });
    if (activeIdeas.length > 0) {
      const idea = activeIdeas[0];
      await updateIdeaStatus(
        idea.id,
        intent.extractedData.statusChange as never,
        text
      );

      const statusMsg = (
        {
          Done: `Marked as done. "${idea.title}" is off the list.`,
          Parked: `Parked "${idea.title}". I'll stop the reminders.`,
          Abandoned: `Logged as abandoned. "${idea.title}" closed out.`,
          "In Progress": `"${idea.title}" marked as in progress.`,
        } as Record<string, string>
      )[intent.extractedData.statusChange] ?? `Status updated for "${idea.title}".`;

      await postToThread(channelId, threadTs, statusMsg);

      await supabase.from("companion_messages").insert([
        { role: "user", content: text, channel_id: channelId, thread_ts: threadTs },
        { role: "assistant", content: statusMsg, channel_id: channelId, thread_ts: threadTs },
      ]);
      return;
    }
  }

  // ── CAPTURE IDEA (or general AI response) ─────────────────
  const { response, tokensUsed } = await generateCompanionResponse({
    message: text,
    threadTs,
    recentMessages: context.recentMessages,
    relevantIdeas: context.relevantIdeas,
  });

  await postToThread(channelId, threadTs, response);

  await supabase.from("companion_messages").insert([
    {
      role: "user",
      content: text,
      channel_id: channelId,
      thread_ts: threadTs,
    },
    {
      role: "assistant",
      content: response,
      channel_id: channelId,
      thread_ts: threadTs,
      tokens_used: tokensUsed,
    },
  ]);

  if (intent.type === "capture_idea" || intent.type === "other") {
    const idea = await createIdea({
      rawInput: text,
      channelId,
      messageTs,
      threadTs,
      reminderFrequencyHours: intent.extractedData.reminderFrequency ?? 24,
      dueDate: intent.extractedData.dueDate,
    });

    if (idea) {
      await supabase
        .from("companion_messages")
        .update({ idea_id: idea.id })
        .eq("thread_ts", threadTs);
    }
  }
}

async function handleVoiceInput(
  event: Record<string, unknown>,
  audioFile: Record<string, unknown>,
  channelId: string,
  messageTs: string,
  supabase: ReturnType<typeof createPersonalSupabaseAdmin>
) {
  const threadTs = messageTs;

  await postToThread(
    channelId,
    threadTs,
    "Processing your voice note..."
  );

  const fileUrl =
    (audioFile.url_private_download as string) ||
    (audioFile.url_private as string);

  if (!fileUrl) {
    await postToThread(channelId, threadTs, "Couldn't access the audio file. Please try again.");
    return;
  }

  const audioBuffer = await downloadFile(fileUrl);
  if (!audioBuffer) {
    await postToThread(channelId, threadTs, "Failed to download the audio. Try again.");
    return;
  }

  const fileName = (audioFile.name as string) ?? "audio.mp4";
  const transcription = await transcribeAudio(audioBuffer, fileName);

  if (!transcription) {
    await postToThread(channelId, threadTs, "Couldn't transcribe that. The recording may be too short. Try again.");
    return;
  }

  console.log("[companion] transcription:", transcription.slice(0, 100));

  await handleTextInput(
    transcription,
    channelId,
    messageTs,
    threadTs,
    supabase,
    process.env.SLACK_BRANDON_USER_ID!
  );
}
