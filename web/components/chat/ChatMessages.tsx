import clsx from 'clsx';
import { RefObject } from 'react';

import type { ChatBubble } from './types';

type VoiceState = "idle" | "recording" | "processing" | "speaking" | "interrupted";

interface ChatMessagesProps {
  messages: ReadonlyArray<ChatBubble>;
  isWaitingForResponse: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** Current voice pipeline state forwarded from ChatInput */
  voiceState?: VoiceState;
  /** Live transcript of what the user just said */
  liveTranscript?: string;
}

export function ChatMessages({
  messages,
  isWaitingForResponse,
  scrollContainerRef,
  onScroll,
  voiceState = 'idle',
  liveTranscript = '',
}: ChatMessagesProps) {
  const showVoiceBanner = voiceState !== 'idle';

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScroll}
      className="flex h-[70vh] flex-col gap-2 overflow-y-auto p-4"
    >
      {messages.length === 0 && !showVoiceBanner && <EmptyState />}

      {messages.map((message, index) => {
        const isUser = message.role === 'user';
        const isDraft = message.role === 'draft';
        const next = messages[index + 1];
        const tail = !next || next.role !== message.role;

        return (
          <div key={message.id} className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
            <div
              className={clsx(
                isUser ? 'bubble-out' : 'bubble-in',
                tail ? (isUser ? 'bubble-tail-out' : 'bubble-tail-in') : '',
                isDraft && 'whitespace-pre-wrap',
              )}
            >
              {/* Voice badge on assistant messages */}
              {!isUser && message.isVoice && (
                <span className={`mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-widest ${
                  message.interrupted ? "text-amber-400" : "text-violet-400"
                }`}>
                  <SpeakerIcon className="h-3 w-3" />
                  {message.interrupted ? "interrupted" : "voice"}
                </span>
              )}
              <span className={isDraft ? 'block whitespace-pre-wrap' : 'whitespace-pre-wrap'}>
                {message.text}
              </span>
            </div>
          </div>
        );
      })}

      {/* Live transcript bubble — appears while user is still speaking */}
      {voiceState === 'recording' && liveTranscript && (
        <div className="flex justify-end">
          <div className="bubble-out bubble-tail-out opacity-60 italic">
            <span className="whitespace-pre-wrap">{liveTranscript}</span>
            <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400 align-middle" />
          </div>
        </div>
      )}

      {/* Voice pipeline state banners */}
      {voiceState === 'processing' && <ProcessingIndicator />}
      {voiceState === 'speaking' && <SpeakingIndicator />}
      {voiceState === "interrupted" && <InterruptedIndicator />}

      {/* Fallback text typing indicator (non-voice wait) */}
      {isWaitingForResponse && voiceState === 'idle' && <TypingIndicator />}
    </div>
  );
}

// ── Voice state indicators ────────────────────────────────────────────────────

function ProcessingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bubble-in bubble-tail-in flex items-center gap-2">
        <svg className="h-4 w-4 animate-spin text-violet-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        <span className="text-sm text-gray-400">Thinking…</span>
      </div>
    </div>
  );
}
function InterruptedIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bubble-in bubble-tail-in flex items-center gap-2">
        <span className="text-sm text-amber-400">↩</span>
        <span className="text-sm text-gray-400 italic">interrupted</span>
      </div>
    </div>
  );
}

function SpeakingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bubble-in bubble-tail-in flex items-center gap-2">
        <SpeakerIcon className="h-4 w-4 text-violet-400" />
        <div className="flex items-end gap-[3px]">
          {[0, 150, 75, 225, 30].map((delay, i) => (
            <span
              key={i}
              className="w-[3px] rounded-full bg-violet-400"
              style={{
                height: `${8 + (i % 3) * 4}px`,
                animation: `soundbar 0.8s ease-in-out ${delay}ms infinite alternate`,
              }}
            />
          ))}
        </div>
        <span className="text-sm text-gray-400">Speaking…</span>
      </div>
    </div>
  );
}

// ── Existing indicators ───────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bubble-in bubble-tail-in">
        <div className="flex items-center space-x-1">
          <div className="flex space-x-1">
            <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
            <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
            <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" />
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto my-12 max-w-sm text-center text-gray-500">
      <SpeakerIcon className="mx-auto mb-3 h-8 w-8 text-violet-300" />
      <h2 className="mb-2 text-xl font-semibold text-gray-700">Start a conversation</h2>
      <p className="text-sm">
        Tap the mic to speak, or type a message below.
      </p>
    </div>
  );
}

// ── Shared icon ───────────────────────────────────────────────────────────────

function SpeakerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77z" />
    </svg>
  );
}