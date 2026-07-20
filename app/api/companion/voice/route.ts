import { NextResponse } from "next/server";
import OpenAI from "openai";
import { JARVIS_SYSTEM_PROMPT } from "@/lib/companion-persona";

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// Creates an ephemeral token for the client-side Realtime API connection
export async function POST() {
  try {
    const response = await getOpenAI().beta.realtime.sessions.create({
      model: "gpt-4o-realtime-preview-2024-12-17",
      voice: "onyx",
      instructions: JARVIS_SYSTEM_PROMPT +
        "\n\nIMPORTANT: This is a LIVE voice conversation. Keep responses to 2-4 sentences maximum. Be concise, natural, and conversational. Sound exactly like Jarvis from Iron Man.",
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
      input_audio_transcription: {
        model: "whisper-1",
      },
    });

    return NextResponse.json({ client_secret: response.client_secret });
  } catch (err) {
    console.error("[voice] session creation failed:", err);
    return NextResponse.json(
      { error: "Failed to create voice session" },
      { status: 500 }
    );
  }
}
