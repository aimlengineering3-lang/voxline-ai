import asyncio
import os

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

MODEL = "gemini-3.8-live"
N_SESSIONS = 10
HOLD_S = 5  # sab sessions ko ek saath open rakhne ke liye
TURN_TIMEOUT_S = 20

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

CONFIG = types.LiveConnectConfig(
    response_modalities=["AUDIO"],
    output_audio_transcription=types.AudioTranscriptionConfig(),
)


async def one_session(i: int) -> str:
    try:
        async with client.aio.live.connect(model=MODEL, config=CONFIG) as session:
            await asyncio.sleep(HOLD_S)
            await session.send_client_content(
                turns=types.Content(
                    role="user", parts=[types.Part(text=f"Say the number {i} once.")]
                ),
                turn_complete=True,
            )

            async def drain() -> None:
                async for _ in session.receive():
                    pass

            await asyncio.wait_for(drain(), TURN_TIMEOUT_S)
            return "ok"
    except asyncio.TimeoutError:
        return "TIMEOUT"
    except Exception as e:
        return f"FAILED: {type(e).__name__}: {e}"


async def main() -> None:
    results = await asyncio.gather(*(one_session(i) for i in range(1, N_SESSIONS + 1)))
    for i, r in enumerate(results, 1):
        print(f"session {i}: {r}")


if __name__ == "__main__":
    asyncio.run(main())