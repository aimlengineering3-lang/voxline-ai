import asyncio
import datetime as dt
import os

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

MODEL = "gemini-3.8-live"
OTHER_MODEL = "gemini-3.1-flash-live-preview"
API_VERSION = "v1alpha"

admin = genai.Client(
    api_key=os.environ["GEMINI_API_KEY"],
    http_options=types.HttpOptions(api_version=API_VERSION),
)


def make_config(instruction: str, voice: str) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        output_audio_transcription=types.AudioTranscriptionConfig(),
        system_instruction=instruction,
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
    )


LOCKED = make_config("Always start your answer with the word LOCKED.", "Charon")


def mint_token() -> str:
    print("laptop UTC time:", dt.datetime.now(tz=dt.timezone.utc).isoformat())
    token = admin.auth_tokens.create(
        config=types.CreateAuthTokenConfig(
            uses=1,
            live_connect_constraints=types.LiveConnectConstraints(
                model=MODEL, config=LOCKED
            ),
        )
    )
    return token.name


async def try_session(label: str, token: str, model: str, config) -> None:
    client = genai.Client(
        api_key=token,
        http_options=types.HttpOptions(api_version=API_VERSION),
    )
    transcript = ""
    try:
        async with client.aio.live.connect(model=model, config=config) as session:
            await session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part(text="Say hello.")]),
                turn_complete=True,
            )

            async def drain() -> None:
                nonlocal transcript
                async for msg in session.receive():
                    sc = msg.server_content
                    if sc and sc.output_transcription and sc.output_transcription.text:
                        transcript += sc.output_transcription.text

            await asyncio.wait_for(drain(), 20)
        print(f"[{label}] OK -> {transcript!r}")
    except Exception as e:
        print(f"[{label}] FAILED: {type(e).__name__}: {e}")


async def main() -> None:
    t = mint_token()
    print("token minted (hidden), starts with:", t[:12], "...")
    await try_session("A same config", t, MODEL, LOCKED)
    await try_session("B reuse same token", t, MODEL, LOCKED)

    t2 = mint_token()
    other = make_config("Always start your answer with the word FREE.", "Puck")
    await try_session("C different instruction+voice", t2, MODEL, other)

    t3 = mint_token()
    await try_session("D different model", t3, OTHER_MODEL, LOCKED)


if __name__ == "__main__":
    asyncio.run(main())