"use client";

import { useState, useEffect, useRef, useCallback } from "react";

type ConnectionState = "idle" | "connecting" | "connected" | "error";

export default function VoicePage() {
  const [state, setState] = useState<ConnectionState>("idle");
  const [transcript, setTranscript] = useState<string[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const disconnect = useCallback(() => {
    dcRef.current?.close();
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach(t => t.stop());
    pcRef.current = null;
    dcRef.current = null;
    streamRef.current = null;
    setState("idle");
    setIsListening(false);
    setIsSpeaking(false);
  }, []);

  const connect = useCallback(async () => {
    try {
      setState("connecting");

      const tokenRes = await fetch("/api/companion/voice", { method: "POST" });
      if (!tokenRes.ok) throw new Error("Failed to get voice token");
      const { client_secret } = await tokenRes.json();
      const ephemeralKey = client_secret.value;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audio = new Audio();
      audio.autoplay = true;
      audioRef.current = audio;

      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
        setIsSpeaking(true);
        e.streams[0].getTracks()[0].onended = () => setIsSpeaking(false);
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      setIsListening(true);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);

          if (event.type === "conversation.item.input_audio_transcription.completed") {
            const text = event.transcript;
            if (text) setTranscript(prev => [...prev, `You: ${text}`]);
          }

          if (event.type === "response.audio_transcript.done") {
            const text = event.transcript;
            if (text) setTranscript(prev => [...prev, `Jarvis: ${text}`]);
          }

          if (event.type === "response.audio.started") setIsSpeaking(true);
          if (event.type === "response.audio.done") setIsSpeaking(false);

        } catch {}
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch(
        "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ephemeralKey}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        }
      );

      if (!sdpRes.ok) throw new Error("SDP negotiation failed");

      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setState("connected");

    } catch (err) {
      console.error("[voice] connection failed:", err);
      setState("error");
      disconnect();
    }
  }, [disconnect]);

  const orbBase = "relative w-48 h-48 rounded-full cursor-pointer select-none transition-all duration-500";
  const orbIdle = "bg-gradient-to-br from-[#0E90C8] to-[#030A18] shadow-[0_0_60px_rgba(14,144,200,0.4)]";
  const orbConnecting = "bg-gradient-to-br from-[#0E90C8] to-[#0369A1] shadow-[0_0_80px_rgba(14,144,200,0.6)] animate-pulse";
  const orbListening = "bg-gradient-to-br from-[#1DBBEE] to-[#0E90C8] shadow-[0_0_100px_rgba(29,187,238,0.7)]";
  const orbSpeaking = "bg-gradient-to-br from-[#0E90C8] to-[#030A18] shadow-[0_0_120px_rgba(14,144,200,0.9)]";

  const orbClass = state === "idle" ? orbIdle
    : state === "connecting" ? orbConnecting
    : isSpeaking ? orbSpeaking
    : orbListening;

  const statusText = state === "idle" ? "Tap to activate Jarvis"
    : state === "connecting" ? "Connecting..."
    : isSpeaking ? "Speaking..."
    : "Listening...";

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-12 px-6"
      style={{ background: "radial-gradient(ellipse at center, #0d1b2e 0%, #030A18 70%)" }}
    >
      {/* Header */}
      <div className="text-center">
        <p className="text-[#0E90C8] text-xs font-bold tracking-[0.25em] uppercase mb-2">
          OperationAMZ
        </p>
        <h1 className="text-white text-2xl font-light tracking-widest">
          Executive AI
        </h1>
      </div>

      {/* Orb */}
      <div className="flex flex-col items-center gap-8">
        <div
          className={`${orbBase} ${orbClass}`}
          onClick={state === "idle" ? connect : state === "connected" ? disconnect : undefined}
        >
          {/* Inner ring */}
          <div
            className="absolute inset-3 rounded-full border border-[#0E90C8]/30"
            style={{
              animation: state === "connected" && isListening && !isSpeaking
                ? "spin 8s linear infinite"
                : "none",
            }}
          />
          {/* Core glow */}
          <div className="absolute inset-8 rounded-full bg-[#0E90C8]/10 backdrop-blur-sm" />
          {/* Speaking wave rings */}
          {isSpeaking && (
            <>
              <div className="absolute -inset-2 rounded-full border border-[#0E90C8]/20 animate-ping" />
              <div
                className="absolute -inset-6 rounded-full border border-[#0E90C8]/10 animate-ping"
                style={{ animationDelay: "0.3s" }}
              />
            </>
          )}
        </div>

        {/* Status */}
        <div className="text-center">
          <p className="text-[#0E90C8] text-sm font-medium tracking-wider">
            {statusText}
          </p>
          {state === "connected" && (
            <p className="text-white/30 text-xs mt-1">Tap orb to disconnect</p>
          )}
          {state === "error" && (
            <p className="text-red-400 text-xs mt-1">Connection failed. Try again.</p>
          )}
        </div>
      </div>

      {/* Transcript */}
      {transcript.length > 0 && (
        <div className="w-full max-w-lg bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-5 max-h-64 overflow-y-auto">
          <div className="flex flex-col gap-3">
            {transcript.map((line, i) => {
              const isJarvis = line.startsWith("Jarvis:");
              return (
                <div key={i} className={`text-sm ${isJarvis ? "text-[#0E90C8]" : "text-white/70"}`}>
                  <span className="font-semibold">
                    {isJarvis ? "Jarvis" : "You"}:
                  </span>{" "}
                  {line.replace(/^(Jarvis|You): /, "")}
                </div>
              );
            })}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      )}

      {/* Back to dashboard */}
      <a href="/dashboard" className="text-white/30 text-xs hover:text-white/60 transition">
        ← Dashboard
      </a>

      <style jsx>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
