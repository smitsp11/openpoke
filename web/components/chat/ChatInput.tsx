"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type VoiceState = "idle" | "recording" | "processing" | "speaking";

interface ChatInputProps {
  value: string;
  canSubmit: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
  voiceWsUrl?: string;
  onVoiceReply?: (text: string) => void;
  /** Notifies the parent whenever the voice pipeline state changes */
  onVoiceStateChange?: (state: VoiceState) => void;
  /** Streams the live transcript up to the parent as it arrives */
  onLiveTranscript?: (transcript: string) => void;
}

export function ChatInput({
  value,
  canSubmit,
  placeholder,
  onChange,
  onSubmit,
  voiceWsUrl = "ws://localhost:8000/chat/voice",
  onVoiceReply,
  onVoiceStateChange,
  onLiveTranscript,
}: ChatInputProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState<string>("");
  const [voiceError, setVoiceError] = useState<string>("");

  const wsRef            = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef  = useRef<AudioContext | null>(null);
  const analyserRef      = useRef<AnalyserNode | null>(null);
  const animFrameRef     = useRef<number>(0);
  const canvasRef        = useRef<HTMLCanvasElement>(null);

  // Wrap setVoiceState so the parent is always notified in one place
  const updateVoiceState = useCallback((state: VoiceState) => {
    setVoiceState(state);
    onVoiceStateChange?.(state);
  }, [onVoiceStateChange]);

  // Wrap setTranscript so the parent is always notified in one place
  const updateTranscript = useCallback((text: string) => {
    setTranscript(text);
    onLiveTranscript?.(text);
  }, [onLiveTranscript]);

  // ── Waveform visualiser ────────────────────────────────────────────────────
  const drawWaveform = useCallback(() => {
    const canvas   = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext("2d")!;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(buf);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth   = 2;
    ctx.strokeStyle = "#a78bfa";
    ctx.beginPath();

    const sliceWidth = canvas.width / buf.length;
    let x = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] / 128.0;
      const y = (v * canvas.height) / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    animFrameRef.current = requestAnimationFrame(drawWaveform);
  }, []);

  // ── WebSocket helpers ──────────────────────────────────────────────────────
  const connectWs = useCallback((): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const ws   = new WebSocket(voiceWsUrl);
      ws.onopen  = () => resolve(ws);
      ws.onerror = () => reject(new Error("WebSocket connection failed"));

      ws.onmessage = async (event) => {
        const frame = JSON.parse(event.data as string);

        if (frame.type === "transcript") {
          updateTranscript(frame.text as string);           // ← was setTranscript
        }

        if (frame.type === "text" && onVoiceReply) {
          onVoiceReply(frame.text as string);
        }

        if (frame.type === "audio") {
          updateVoiceState("speaking");                     // ← was setVoiceState
          const mp3  = Uint8Array.from(atob(frame.data as string), (c) => c.charCodeAt(0));
          const blob = new Blob([mp3], { type: "audio/mpeg" });
          const url  = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => {
            URL.revokeObjectURL(url);
            updateVoiceState("idle");                       // ← was setVoiceState
            updateTranscript("");                           // ← was setTranscript
          };
          await audio.play();
        }

        if (frame.type === "error") {
          setVoiceError(frame.message as string);
          updateVoiceState("idle");                         // ← was setVoiceState
        }
      };

      wsRef.current = ws;
    });
  }, [voiceWsUrl, onVoiceReply, updateVoiceState, updateTranscript]);

  // ── Start recording ────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    setVoiceError("");
    updateTranscript("");                                   // ← was setTranscript

    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ac       = new AudioContext();
      const source   = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioContextRef.current = ac;
      analyserRef.current     = analyser;
      animFrameRef.current    = requestAnimationFrame(drawWaveform);

      const ws       = await connectWs();
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

      recorder.ondataavailable = (e) => {
        if (e.data.size === 0 || ws.readyState !== WebSocket.OPEN) return;
        const reader      = new FileReader();
        reader.onloadend  = () => {
          const b64 = (reader.result as string).split(",")[1];
          ws.send(JSON.stringify({ type: "audio", data: b64 }));
        };
        reader.readAsDataURL(e.data);
      };

      recorder.start(250);
      mediaRecorderRef.current = recorder;
      updateVoiceState("recording");                       // ← was setVoiceState
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "Microphone error");
    }
  }, [connectWs, drawWaveform, updateVoiceState, updateTranscript]);

  // ── Stop recording ─────────────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current     = null;

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      recorder.stream.getTracks().forEach((t) => t.stop());
    }
    mediaRecorderRef.current = null;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "commit" }));
      updateVoiceState("processing");                      // ← was setVoiceState
    }
  }, [updateVoiceState]);

  // ── Toggle mic ─────────────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    if (voiceState === "recording") stopRecording();
    else if (voiceState === "idle") void startRecording();
  }, [voiceState, startRecording, stopRecording]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      wsRef.current?.close();
      audioContextRef.current?.close();
    };
  }, []);

  // ── Text submit ────────────────────────────────────────────────────────────
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    void onSubmit();
  };

  const isVoiceActive = voiceState !== "idle";

  return (
    <div className="flex flex-col gap-2">
      {isVoiceActive && (
        <div className="flex items-center gap-3 rounded-lg bg-neutral-900 px-3 py-2">
          <canvas
            ref={canvasRef}
            width={200}
            height={32}
            className={voiceState === "recording" ? "opacity-100" : "opacity-30"}
          />
          <span className="text-xs text-violet-400 capitalize tracking-wide">
            {voiceState === "processing" ? "thinking…" : voiceState}
          </span>
          {transcript && (
            <span className="ml-auto max-w-xs truncate text-xs text-neutral-400 italic">
              "{transcript}"
            </span>
          )}
        </div>
      )}

      {voiceError && (
        <p className="text-xs text-red-400 px-1">{voiceError}</p>
      )}

      <form className="flex items-center gap-2" onSubmit={handleSubmit}>
        <input
          className="input flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={isVoiceActive ? "Listening…" : placeholder}
          disabled={isVoiceActive}
        />

        <button type="submit" className="btn" disabled={!canSubmit || isVoiceActive}>
          Send
        </button>

        <button
          type="button"
          onClick={toggleMic}
          disabled={voiceState === "processing" || voiceState === "speaking"}
          className={[
            "relative flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200",
            voiceState === "recording"
              ? "bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.6)] scale-110"
              : voiceState === "processing" || voiceState === "speaking"
              ? "bg-violet-800 opacity-50 cursor-not-allowed"
              : "bg-violet-600 hover:bg-violet-500 hover:scale-105",
          ].join(" ")}
          aria-label={voiceState === "recording" ? "Stop recording" : "Start voice input"}
        >
          {voiceState === "processing" ? (
            <svg className="h-4 w-4 animate-spin text-white" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          ) : voiceState === "recording" ? (
            <span className="h-3 w-3 rounded-sm bg-white" />
          ) : (
            <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4zm-7 10a7 7 0 0014 0h2a9 9 0 01-8 8.94V22h-2v-2.06A9 9 0 013 11H5z" />
            </svg>
          )}
          {voiceState === "recording" && (
            <span className="absolute inset-0 rounded-full animate-ping bg-red-400 opacity-30" />
          )}
        </button>
      </form>
    </div>
  );
}