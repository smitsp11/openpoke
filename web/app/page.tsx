'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import SettingsModal, { useSettings } from '@/components/SettingsModal';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { ChatInput } from '@/components/chat/ChatInput';
import { ChatMessages } from '@/components/chat/ChatMessages';
import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { useAutoScroll } from '@/components/chat/useAutoScroll';
import type { ChatBubble } from '@/components/chat/types';

const POLL_INTERVAL_MS = 1500;

type VoiceState = 'idle' | 'recording' | 'processing' | 'speaking' | 'interrupted';

// ── Helpers ───────────────────────────────────────────────────────────────────

const formatEscapeCharacters = (text: string): string =>
  text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');

const isRenderableMessage = (entry: any) =>
  typeof entry?.role === 'string' &&
  typeof entry?.content === 'string' &&
  entry.content.trim().length > 0;

const toBubbles = (payload: any): ChatBubble[] => {
  if (!Array.isArray(payload?.messages)) return [];
  return payload.messages
    .filter(isRenderableMessage)
    .map((message: any, index: number) => ({
      id:   `history-${index}`,
      role: message.role,
      text: formatEscapeCharacters(message.content),
    }));
};

// ── Voice WebSocket URL ───────────────────────────────────────────────────────

const VOICE_WS_URL =
  typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/chat`
    : 'ws://localhost:3000/api/chat';

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Page() {
  const { settings, setSettings } = useSettings();
  const [open, setOpen]                      = useState(false);
  const [input, setInput]                    = useState('');
  const [messages, setMessages]              = useState<ChatBubble[]>([]);
  const [error, setError]                    = useState<string | null>(null);
  const [isWaitingForResponse, setIsWaiting] = useState(false);
  const [voiceState, setVoiceState]          = useState<VoiceState>('idle');
  const [liveTranscript, setLiveTranscript]  = useState('');

  // Track the id of the last assistant voice bubble so barge-in can flag it
  const lastVoiceBubbleIdRef = useRef<string | null>(null);

  const { scrollContainerRef, handleScroll } = useAutoScroll({
    items:     messages,
    isWaiting: isWaitingForResponse,
  });

  const openSettings  = useCallback(() => setOpen(true),  []);
  const closeSettings = useCallback(() => setOpen(false), []);

  // ── History ──────────────────────────────────────────────────────────────

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/chat/history', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setMessages(toBubbles(data));
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      console.error('Failed to load chat history', err);
    }
  }, []);

  const handleTextChunk = useCallback((chunk: string) => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      // If the last bubble is an in-progress voice bubble, append to it
      if (last?.role === 'assistant' && last?.isVoice && !last?.interrupted) {
        return [
          ...prev.slice(0, -1),
          { ...last, text: last.text + chunk },
        ];
      }
      // Otherwise create a new one
      const id = `voice-assistant-${Date.now()}`;
      lastVoiceBubbleIdRef.current = id;
      return [...prev, { id, role: 'assistant', text: chunk, isVoice: true, interrupted: false }];
    });
  }, []);

  const handleTextDone = useCallback(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  useEffect(() => {
    const id = window.setInterval(() => void loadHistory(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [loadHistory]);

  // ── Timezone detection ────────────────────────────────────────────────────

  useEffect(() => {
    const detect = async () => {
      if (settings.timezone) return;
      try {
        const tz  = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const res = await fetch('/api/timezone', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ timezone: tz }),
        });
        if (res.ok) setSettings({ ...settings, timezone: tz });
      } catch { /* non-critical */ }
    };
    void detect();
  }, [settings, setSettings]);

  // ── Text send ─────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setError(null);
    setIsWaiting(true);

    const userBubble: ChatBubble = {
      id:   `user-${Date.now()}`,
      role: 'user',
      text: formatEscapeCharacters(trimmed),
    };
    setMessages(prev => [...prev, userBubble]);

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ messages: [{ role: 'user', content: trimmed }] }),
      });
      if (!(res.ok || res.status === 202)) {
        throw new Error((await res.text()) || `Request failed (${res.status})`);
      }
    } catch (err: any) {
      console.error('Failed to send message', err);
      setError(err?.message || 'Failed to send message');
      setMessages(prev => prev.filter(m => m.id !== userBubble.id));
      setIsWaiting(false);
      throw err instanceof Error ? err : new Error('Failed to send message');
    } finally {
      let attempts = 0;
      const poll = async () => {
        attempts++;
        try {
          const res = await fetch('/api/chat/history', { cache: 'no-store' });
          if (res.ok) {
            const current = toBubbles(await res.json());
            const last    = current[current.length - 1];
            const hasUser = current.some(m => m.text === trimmed && m.role === 'user');
            if (last?.role === 'assistant' && hasUser) {
              setMessages(current);
              setIsWaiting(false);
              return;
            }
          }
        } catch { /* swallow poll errors */ }
        if (attempts < 30) setTimeout(poll, 1000);
        else { setIsWaiting(false); void loadHistory(); }
      };
      setTimeout(poll, 1000);
    }
  }, [loadHistory]);

  // ── Voice reply ───────────────────────────────────────────────────────────

  const handleVoiceReply = useCallback((text: string) => {
    const id = `voice-assistant-${Date.now()}`;
    lastVoiceBubbleIdRef.current = id;

    setMessages(prev => [
      ...prev,
      {
        id,
        role:        'assistant',
        text:        formatEscapeCharacters(text),
        isVoice:     true,
        interrupted: false,
      } satisfies ChatBubble,
    ]);
    void loadHistory();
  }, [loadHistory]);

  // ── Barge-in ──────────────────────────────────────────────────────────────

  const handleBargein = useCallback(() => {
    const targetId = lastVoiceBubbleIdRef.current;
    if (!targetId) return;

    setMessages(prev =>
      prev.map(m =>
        m.id === targetId ? { ...m, interrupted: true } : m
      )
    );
  }, []);

  // ── Clear history ─────────────────────────────────────────────────────────

  const handleClearHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/chat/history', { method: 'DELETE' });
      if (!res.ok) { console.error('Failed to clear history', res.statusText); return; }
      setMessages([]);
      lastVoiceBubbleIdRef.current = null;
    } catch (err) {
      console.error('Failed to clear history', err);
    }
  }, []);

  // ── Text submit ───────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!input.trim()) return;
    const value = input;
    setInput('');
    try { await sendMessage(value); }
    catch { setInput(value); }
  }, [input, sendMessage]);

  const canSubmit = input.trim().length > 0 && voiceState === 'idle';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="chat-bg min-h-screen p-4 sm:p-6">
      <div className="chat-wrap flex flex-col">
        <ChatHeader
          onOpenSettings={openSettings}
          onClearHistory={() => void handleClearHistory()}
        />

        <div className="card flex-1 overflow-hidden">
          <ChatMessages
            messages={messages}
            isWaitingForResponse={isWaitingForResponse}
            scrollContainerRef={scrollContainerRef}
            onScroll={handleScroll}
            voiceState={voiceState}
            liveTranscript={liveTranscript}
          />

          <div className="border-t border-gray-200 p-3">
            {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

            <ChatInput
              value={input}
              canSubmit={canSubmit}
              placeholder={voiceState === 'idle' ? 'Type a message…' : 'Listening…'}
              onChange={setInput}
              onSubmit={handleSubmit}
              voiceWsUrl={VOICE_WS_URL}
              onTextChunk={handleTextChunk}
              onTextDone={handleTextDone}
              onVoiceStateChange={setVoiceState}
              onLiveTranscript={setLiveTranscript}
              onBargein={handleBargein}
            />
          </div>
        </div>

        <SettingsModal
          open={open}
          onClose={closeSettings}
          settings={settings}
          onSave={setSettings}
        />
      </div>
    </main>
  );
}