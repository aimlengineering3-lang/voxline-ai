import asyncio
import datetime as dt
import os
import wave
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

MODEL = "gemini-3.8-live"
VOICES = ["Charon", "Achird", "Kore", "Puck", "Sulafat", "Schedar"]
PROMPT = (
    "Please say exactly this sentence: "
    "Hello, I'm your Voxline assistant. How can I help you today?"
)
OUT = Path(__file__).parent / "audio"
OUT.mkdir(exist_ok=True)


def config(voice: str) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction="You are a warm, clear voice assistant.",
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
    )


def save_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)


async def record(client: genai.Client, cfg: types.LiveConnectConfig) -> bytes:
    pcm = bytearray()
    async with client.aio.live.connect(model=MODEL, config=cfg) as session:
        await session.send_client_content(
            turns=types.Content(role="user", parts=[types.Part(text=PROMPT)]),
            turn_complete=True,
        )

        async def drain() -> None:
            async for msg in session.receive():
                sc = msg.server_content
                if sc and sc.model_turn:
                    for part in sc.model_turn.parts or []:
                        if part.inline_data and part.inline_data.data:
                            pcm.extend(part.inline_data.data)

        await asyncio.wait_for(drain(), 30)
    return bytes(pcm)


async def main() -> None:
    direct = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    for voice in VOICES:
        pcm = await record(direct, config(voice))
        save_wav(OUT / f"{voice}.wav", pcm)
        print(f"saved {voice}.wav ({len(pcm)} bytes)")

    # voice lock test: token locked to Charon, client asks for Puck
    admin = genai.Client(
        api_key=os.environ["GEMINI_API_KEY"],
        http_options=types.HttpOptions(api_version="v1alpha"),
    )
    token = admin.auth_tokens.create(
        config=types.CreateAuthTokenConfig(
            uses=1,
            live_connect_constraints=types.LiveConnectConstraints(
                model=MODEL, config=config("Charon")
            ),
        )
    )
    tok_client = genai.Client(
        api_key=token.name,
        http_options=types.HttpOptions(api_version="v1alpha"),
    )
    pcm = await record(tok_client, config("Puck"))
    save_wav(OUT / "LOCKTEST_token_Charon_client_Puck.wav", pcm)
    print(f"saved LOCKTEST file ({len(pcm)} bytes)")


if __name__ == "__main__":
    asyncio.run(main())