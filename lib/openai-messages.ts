import OpenAI from "openai";
import type { getFollowupUrgency } from "./followup-schedule";

let _openai: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

export async function parseTaskFromMessage(
  messageText: string,
  assigneeName: string
): Promise<{ taskText: string; hasTask: boolean } | null> {
  try {
    const response = await getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a task parser for a Slack workspace.
Extract the task description from a message where someone is assigning work to ${assigneeName}.
Return JSON only with these fields:
{
  "hasTask": boolean,
  "taskText": "clean description of what needs to be done"
}
If the message is not assigning a task, set hasTask to false and taskText to "".
Keep taskText concise but complete — include deadlines if mentioned.`,
        },
        {
          role: "user",
          content: messageText,
        },
      ],
      max_tokens: 200,
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(
      response.choices[0]?.message?.content ?? "{}"
    );
    return result;
  } catch {
    return null;
  }
}

export async function generateFollowupMessage(options: {
  taskText: string;
  assigneeName: string;
  assignerName: string;
  followupNumber: number;
  urgency: ReturnType<typeof getFollowupUrgency>;
  nextFollowupHuman?: string | null;
}): Promise<string> {
  const { taskText, assigneeName, assignerName, urgency, nextFollowupHuman } = options;

  const toneGuide = {
    gentle:
      "Very friendly and casual. Just a light reminder. Short — 1-2 sentences max.",
    friendly:
      "Friendly but slightly more direct. Still warm but making sure they see it.",
    firm: "Professional and clear. No fluff. They need to respond.",
    urgent:
      "Direct and urgent. Make clear this has been waiting a while and needs immediate attention.",
    final:
      "Final notice tone. This is the last follow-up before escalating to management. Be serious but not rude.",
  };

  try {
    const response = await getOpenAIClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You write Slack follow-up messages for task reminders.
Tone: ${toneGuide[urgency]}
Rules:
- Address ${assigneeName} directly (use their name)
- Reference the specific task: "${taskText}"
- NEVER mention follow-up numbers or counts (no "follow-up 1 of 5", no "second reminder", nothing like that)
- Never use em-dashes
- No generic openers like "Hey there"
- Sound like a real person, not a bot
- Do NOT say "I'm a bot" or mention automation
- Keep it conversational and natural
- End with a clear call to action (reply with "done" when complete)`,
        },
        {
          role: "user",
          content: `Write a follow-up message for ${assigneeName} about this task: "${taskText}". This was assigned by ${assignerName}.${nextFollowupHuman ? ` If they don't respond, the next follow-up will be sent ${nextFollowupHuman}. Do NOT include that timestamp in the message.` : ""}`,
        },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    return (
      response.choices[0]?.message?.content?.trim() ??
      `Hey ${assigneeName}, just checking in on: "${taskText}". Let us know when it's done by replying here.`
    );
  } catch {
    return `Hey ${assigneeName}, following up on: "${taskText}". Please reply here when it's complete.`;
  }
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  fileName: string
): Promise<string | null> {
  try {
    const openai = getOpenAIClient();

    // Use Uint8Array so the File gets exactly the right bytes —
    // Buffer.buffer is a pooled ArrayBuffer that may be larger than the actual data.
    const mimeType = fileName.endsWith(".webm")
      ? "audio/webm"
      : fileName.endsWith(".mp4") || fileName.endsWith(".m4a")
      ? "audio/mp4"
      : fileName.endsWith(".ogg")
      ? "audio/ogg"
      : "audio/mpeg";

    const file = new File([new Uint8Array(audioBuffer)], fileName, { type: mimeType });

    console.log("[whisper] sending file:", fileName, "size:", file.size, "type:", mimeType);

    const transcription = await openai.audio.transcriptions.create({
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

export async function parseVoiceTranscription(
  transcription: string,
  knownTeamMembers: Array<{ id: string; name: string }>
): Promise<{
  hasTask: boolean;
  taskText: string;
  mentionedNames: string[];
  assigneeCleared: boolean;
  summary: string;
} | null> {
  try {
    const openai = getOpenAIClient();
    const memberList = knownTeamMembers.map(m => m.name).join(", ");

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You parse voice recording transcriptions from a business owner assigning tasks to their team.

Known team members: ${memberList}

Return JSON with these fields:
{
  "hasTask": boolean,
  "taskText": "clear, complete description of the task to be done. Include all details, deadlines, and context mentioned.",
  "mentionedNames": ["name1", "name2"],
  "assigneeCleared": boolean,
  "summary": "1-2 sentence summary of the task for the thread reply"
}

Rules:
- hasTask: true if any work assignment or action item is mentioned
- taskText: comprehensive task description, preserve all specifics from the recording
- mentionedNames: any names from the known team member list that appear in the transcription
- assigneeCleared: true if it is clear who should do the task, false if ambiguous
- summary: friendly summary to post back to Slack so the team knows the task was understood

If no task is found, set hasTask to false and all other fields to empty/false.`,
        },
        {
          role: "user",
          content: `Transcription: "${transcription}"`,
        },
      ],
      max_tokens: 500,
      temperature: 0,
      response_format: { type: "json_object" },
    });

    return JSON.parse(response.choices[0]?.message?.content ?? "{}");
  } catch (err) {
    console.error("[openai] voice parse failed:", err);
    return null;
  }
}

export async function generateEscalationMessage(options: {
  taskText: string;
  assigneeName: string;
  channelId: string;
  threadTs: string;
  followupsSent: number;
}): Promise<string> {
  const { taskText, assigneeName, channelId, threadTs } = options;

  return (
    `🚨 *Task Escalation Alert*\n\n` +
    `*Assignee:* ${assigneeName}\n` +
    `*Task:* ${taskText}\n` +
    `*Status:* No response after 5 follow-ups\n\n` +
    `${assigneeName} has not confirmed completion of this task after 5 automated follow-ups. ` +
    `You may want to reach out directly.\n\n` +
    `<slack://channel?team=T&id=${channelId}&message=${threadTs}|View original thread>`
  );
}
