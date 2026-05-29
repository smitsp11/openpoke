from fastapi import APIRouter
import re
from fastapi.responses import JSONResponse
import asyncio
from ..utils.tts_sanitizer import sanitize_for_tts




from ..openrouter_client import get_openrouter_client
from ..models import ChatHistoryClearResponse, ChatHistoryResponse, ChatRequest
from ..services import get_conversation_log, get_trigger_service, handle_chat_request
from ..services.execution.hot_cache import reset_session_cache

router = APIRouter(prefix="/chat", tags=["chat"])




@router.post("/send", response_class=JSONResponse, summary="Submit a chat message and receive a completion")
# Handle incoming chat messages and route them to the interaction agent
async def chat_send(
    payload: ChatRequest,
) -> JSONResponse:
    return await handle_chat_request(payload)


@router.get("/history", response_model=ChatHistoryResponse)
# Retrieve the conversation history from the log
def chat_history() -> ChatHistoryResponse:
    log = get_conversation_log()
    return ChatHistoryResponse(messages=log.to_chat_messages())


@router.delete("/history", response_model=ChatHistoryClearResponse)
def clear_history() -> ChatHistoryClearResponse:
    from ..services import get_execution_agent_logs, get_agent_roster

    # Clear conversation log
    log = get_conversation_log()
    log.clear()

    # Clear execution agent logs
    execution_logs = get_execution_agent_logs()
    execution_logs.clear_all()

    # Clear agent roster
    roster = get_agent_roster()
    roster.clear()

    # Clear stored triggers
    trigger_service = get_trigger_service()
    trigger_service.clear_all()

    reset_session_cache()

    return ChatHistoryClearResponse()


__all__ = ["router"]
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import asyncio, base64, json, httpx

from ..models import ChatHistoryClearResponse, ChatHistoryResponse, ChatRequest
from ..services import get_conversation_log, get_trigger_service, handle_chat_request
from ..services.execution.hot_cache import reset_session_cache
from ..config import settings

router = APIRouter(prefix="/chat", tags=["chat"])


# ── Helpers ──────────────────────────────────────────────────────────────────

async def transcribe_audio(audio_bytes: bytes) -> str:
    """Send raw audio to Deepgram and return transcript."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true",
            headers={
                "Authorization": f"Token {settings.deepgram_api_key}",
                "Content-Type": "audio/webm",
            },
            content=audio_bytes,
            timeout=15,
        )
        r.raise_for_status()
        return r.json()["results"]["channels"][0]["alternatives"][0]["transcript"]


async def synthesize_speech(text: str) -> bytes:
    """Convert text to speech via ElevenLabs and return raw MP3 bytes."""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{settings.elevenlabs_voice_id}",
            headers={
                "xi-api-key": settings.elevenlabs_api_key,
                "Content-Type": "application/json",
            },
            json={
                "text": text,
                "model_id": "eleven_turbo_v2",
                "voice_settings": {"stability": 0.4, "similarity_boost": 0.8},
            },
            timeout=20,
        )
        r.raise_for_status()
        return r.content


# ── Voice WebSocket ───────────────────────────────────────────────────────────

@router.websocket("/voice")
async def voice_chat(ws: WebSocket):
    """
    WebSocket voice pipeline.

    Client sends JSON frames:
      { "type": "audio",  "data": "<base64-encoded audio chunk>" }
      { "type": "commit" }   ← signals end of utterance; triggers STT → LLM → TTS

    Server sends JSON frames back:
      { "type": "transcript", "text": "..."  }   ← what the user said
      { "type": "text",       "text": "..."  }   ← agent reply text
      { "type": "audio",      "data": "..."  }   ← base64 MP3 response
      { "type": "error",      "message": "..." }
    """
    await ws.accept()
    audio_buffer: list[bytes] = []

    pipeline_task: asyncio.Task | None = None

    try:
        while True:
            raw = await ws.receive_text()
            frame = json.loads(raw)

            if frame["type"] == "audio":
                audio_buffer.append(base64.b64decode(frame["data"]))

            elif frame["type"] == "barge_in":
                if pipeline_task and not pipeline_task.done():
                    pipeline_task.cancel()
                    try:
                        await pipeline_task
                    except asyncio.CancelledError:
                        pass
                audio_buffer.clear()
                await ws.send_text(json.dumps({"type": "barge_in_ack"}))

            elif frame["type"] == "commit":
                if not audio_buffer:
                    continue

                audio_bytes = b"".join(audio_buffer)
                audio_buffer.clear()

                async def run_pipeline(audio: bytes, ws: WebSocket) -> None:
    # 1. STT — unchanged
    try:
        transcript = await transcribe_audio(audio)
    except Exception as e:
        await ws.send_text(json.dumps({"type": "error", "message": f"STT failed: {e}"}))
        return
    if not transcript.strip():
        return
    await ws.send_text(json.dumps({"type": "transcript", "text": transcript}))

    # 2. Stream LLM tokens, buffer into sentences, fire TTS per sentence
    client      = get_openrouter_client()
    buffer      = ""
    chunk_index = 0
    tts_tasks: list[asyncio.Task] = []

    async def tts_and_send(sentence: str, index: int) -> None:
        clean = sanitize_for_tts(sentence)
        if not clean:
            # Nothing speakable — skip this chunk entirely,
            # but still send a silent placeholder so the client
            # index sequence stays contiguous
            await ws.send_text(json.dumps({
                "type":  "audio_chunk_skip",
                "index": index,
            }))
            return
        try:
            mp3       = await synthesize_speech(clean)
            audio_b64 = base64.b64encode(mp3).decode()
            await ws.send_text(json.dumps({
                "type":  "audio_chunk",
                "data":  audio_b64,
                "index": index,
            }))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await ws.send_text(json.dumps({"type": "error", "message": f"TTS failed: {e}"}))


# ── Existing REST endpoints (unchanged) ──────────────────────────────────────

@router.post("/send", response_class=JSONResponse)
async def chat_send(payload: ChatRequest) -> JSONResponse:
    return await handle_chat_request(payload)


@router.get("/history", response_model=ChatHistoryResponse)
def chat_history() -> ChatHistoryResponse:
    log = get_conversation_log()
    return ChatHistoryResponse(messages=log.to_chat_messages())


@router.delete("/history", response_model=ChatHistoryClearResponse)
def clear_history() -> ChatHistoryClearResponse:
    from ..services import get_execution_agent_logs, get_agent_roster

    log = get_conversation_log()
    log.clear()
    get_execution_agent_logs().clear_all()
    get_agent_roster().clear()
    get_trigger_service().clear_all()
    reset_session_cache()

    return ChatHistoryClearResponse()


__all__ = ["router"]