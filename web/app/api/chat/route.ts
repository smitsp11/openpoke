export const runtime = 'nodejs';

// ── Types ─────────────────────────────────────────────────────────────────────

type UIMsgPart = { type: string; text?: string };
type UIMessage  = { role: string; parts?: UIMsgPart[]; content?: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function uiToOpenAIContent(messages: UIMessage[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (const m of messages ?? []) {
    if (!m?.role) continue;
    let content = '';
    if (Array.isArray(m.parts)) {
      content = m.parts.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('');
    } else if (typeof m.content === 'string') {
      content = m.content;
    }
    out.push({ role: m.role, content });
  }
  return out;
}

function serverBase() {
  return (process.env.PY_SERVER_URL ?? 'http://localhost:8001').replace(/\/$/, '');
}

// ── POST  /api/chat  (text path — unchanged) ──────────────────────────────────

export async function POST(req: Request) {
  let body: { messages?: UIMessage[] };
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { messages } = body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response('Missing messages', { status: 400 });
  }

  const path    = process.env.PY_CHAT_PATH ?? '/api/v1/chat/send';
  const url     = `${serverBase()}${path}`;
  const payload = { system: '', messages: uiToOpenAIContent(messages), stream: false };

  try {
    const upstream = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/plain, */*' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(30_000),
    });
    return new Response(await upstream.text(), {
      status:  upstream.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (e: unknown) {
    const isTimeout = e instanceof DOMException && e.name === 'TimeoutError';
    console.error('[chat-proxy] upstream error', e);
    return new Response(isTimeout ? 'Upstream timed out' : 'Upstream error', {
      status: isTimeout ? 504 : 502,
    });
  }
}

// ── GET  /api/chat  (WebSocket upgrade — voice path) ─────────────────────────
//
// Next.js cannot upgrade a connection to WebSocket itself, so this handler
// acts as a transparent tunnel:
//
//   Browser  ←——WS——→  Next.js GET /api/chat  ←——WS——→  FastAPI /chat/voice
//
// The browser connects to ws://…/api/chat and all JSON frames are forwarded
// verbatim in both directions — no frame parsing needed here.

export async function GET(req: Request) {
  const upgrade = req.headers.get('upgrade') ?? '';
  if (upgrade.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  // @ts-expect-error — Next.js exposes socket on the raw Node request
  const socket: import('net').Socket = (req as any).socket;

  const wsPath   = process.env.PY_VOICE_PATH ?? '/api/v1/chat/voice';
  const upstream = serverBase().replace(/^http/, 'ws') + wsPath;

  // Dynamically import 'ws' — it's a Next.js server dep, not a browser bundle
  const { WebSocket: WS } = await import('ws') as { WebSocket: typeof import('ws') };

  // Grab the raw HTTP upgrade head so we can forward it to FastAPI
  const rawReq   = (req as any)._req ?? (req as any).raw;
  const head     = rawReq?._readableState?.buffer?.head?.data ?? Buffer.alloc(0);

  const pyWs = new (WS as any)(upstream) as import('ws');

  return new Promise<Response>((resolve) => {
    pyWs.once('open', () => {
      // Perform the WebSocket handshake with the browser
      const { WebSocketServer } = require('ws') as typeof import('ws');
      const wss = new WebSocketServer({ noServer: true });

      wss.handleUpgrade(rawReq, socket, head, (browserWs) => {
        // Browser → FastAPI
        browserWs.on('message', (data) => {
          if (pyWs.readyState === pyWs.OPEN) pyWs.send(data);
        });

        // FastAPI → Browser
        pyWs.on('message', (data: import('ws').RawData) => {
          if (browserWs.readyState === browserWs.OPEN) browserWs.send(data);
        });

        const close = (origin: string) => (code?: number, reason?: Buffer) => {
          console.log(`[voice-proxy] closed by ${origin}`, code);
          browserWs.readyState === browserWs.OPEN && browserWs.close(code ?? 1000);
          pyWs.readyState === pyWs.OPEN           && pyWs.close(code ?? 1000);
        };

        browserWs.on('close', close('browser'));
        pyWs.on('close',      close('fastapi'));

        browserWs.on('error', (e) => console.error('[voice-proxy] browser ws error', e));
        pyWs.on('error',      (e) => console.error('[voice-proxy] fastapi ws error', e));
      });

      // Response is irrelevant — the upgrade was already handled on the socket
      resolve(new Response(null, { status: 101 }));
    });

    pyWs.once('error', (e: Error) => {
      console.error('[voice-proxy] could not connect to FastAPI voice WS', e);
      resolve(new Response('Voice upstream unavailable', { status: 502 }));
    });
  });
}