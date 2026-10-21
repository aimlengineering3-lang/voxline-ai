import asyncio
import os
import time

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

MODEL = "gemini-3.8-live"
TURNS = [
    "Hi! Introduce yourself in one short sentence.",
    "Explain what a websocket is, in simple words.",
    "Repeat that, but even shorter.",
]
TURN_TIMEOUT_S = 20

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

CONFIG = types.LiveConnectConfig(
    response_modalities=["AUDIO"],
    output_audio_transcription=types.AudioTranscriptionConfig(),
    input_audio_transcription=types.AudioTranscriptionConfig(),
    system_instruction="You are a concise voice assistant. Keep answers short.",
)


async def run_turn(session, text: str) -> None:
    sent_at = time.perf_counter()
    first_audio_ms = None
    audio_bytes = 0
    transcript = ""
    interrupted = False

    await session.send_client_content(
        turns=types.Content(role="user", parts=[types.Part(text=text)]),
        turn_complete=True,
    )

    async def consume() -> None:
        nonlocal first_audio_ms, audio_bytes, transcript, interrupted
        async for msg in session.receive():
            if msg.go_away:
                print("GOAWAY:", msg.go_away)
            sc = msg.server_content
            if not sc:
                continue
            if sc.model_turn:
                for part in sc.model_turn.parts or []:
                    if part.inline_data and part.inline_data.data:
                        if first_audio_ms is None:
                            first_audio_ms = (time.perf_counter() - sent_at) * 1000
                        audio_bytes += len(part.inline_data.data)
            if sc.output_transcription and sc.output_transcription.text:
                transcript += sc.output_transcription.text
            if sc.interrupted:
                interrupted = True

    try:
        await asyncio.wait_for(consume(), TURN_TIMEOUT_S)
        outcome = "complete"
    except asyncio.TimeoutError:
        outcome = "TIMEOUT"

    print(f"\n--- turn: {text}")
    print("outcome:", outcome)
    print("interrupted:", interrupted)
    print("time to first audio (ms):", f"{first_audio_ms:.0f}" if first_audio_ms else "none")
    print("audio bytes:", audio_bytes)
    print("transcript:", transcript or "(empty)")


async def main() -> None:
    async with client.aio.live.connect(model=MODEL, config=CONFIG) as session:
        print("session open")
        for text in TURNS:
            await run_turn(session, text)
    print("\nsession closed")


if __name__ == "__main__":
    asyncio.run(main())