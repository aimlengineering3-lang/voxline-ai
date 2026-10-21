import asyncio, json, os, sys, time, wave
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()
# Usage: python debug_wer.py [model ...]   (no args = default model below)
# Env switches:  VERBOSE=1  -> print every server message (compact)
#                NO_TRANSCRIBE=1 -> connect without transcription config
MODELS = sys.argv[1:] or ["gemini-2.5-flash-native-audio-latest"]
WAV_PATH = "eval/audio/w1.wav"
CHUNK_MS = 100        # send audio in small chunks, like a live microphone
PACE = 1.0            # 1.0 = real time; raise (e.g. 5.0) to send faster
TRAILING_SILENCE_S = 1.5   # docs: send audio_stream_end only after >1s of silence
TIMEOUT_S = 90
VERBOSE = os.environ.get("VERBOSE") == "1"
NO_TRANSCRIBE = os.environ.get("NO_TRANSCRIBE") == "1"

client = genai.Client(api_key=os.environ["EVAL_GEMINI_API_KEY"])


def make_config():
    kwargs = dict(response_modalities=["AUDIO"])
    if not NO_TRANSCRIBE:
        kwargs["input_audio_transcription"] = types.AudioTranscriptionConfig()
        kwargs["output_audio_transcription"] = types.AudioTranscriptionConfig()
    return types.LiveConnectConfig(**kwargs)


def read_wav(path):
    with wave.open(path, "rb") as w:
        fmt = (w.getframerate(), w.getnchannels(), w.getsampwidth())
        if fmt != (16000, 1, 2):
            raise SystemExit(f"{path} must be 16 kHz, mono, 16-bit PCM; got {fmt}")
        return w.readframes(w.getnframes())


def compact(msg):
    d = msg.model_dump(exclude_none=True)
    text = json.dumps(d, default=lambda o: f"<{type(o).__name__}>")
    return text if len(text) <= 300 else text[:300] + "..."


async def send_audio(s, pcm, t0):
    pcm = pcm + bytes(int(16000 * 2 * TRAILING_SILENCE_S))  # real silence so VAD can end the turn
    step = 16000 * 2 * CHUNK_MS // 1000  # bytes per chunk
    for i in range(0, len(pcm), step):
        await s.send_realtime_input(
            audio=types.Blob(data=pcm[i : i + step], mime_type="audio/pcm;rate=16000")
        )
        await asyncio.sleep(CHUNK_MS / 1000 / PACE)
    await s.send_realtime_input(audio_stream_end=True)
    if VERBOSE:
        print(f"  [{time.perf_counter() - t0:5.1f}s] sent audio + silence + audio_stream_end")


async def recv_transcript(s, t0):
    heard = []
    async for msg in s.receive():
        if VERBOSE:
            print(f"  [{time.perf_counter() - t0:5.1f}s] {compact(msg)}")
        sc = msg.server_content
        if sc and sc.input_transcription and sc.input_transcription.text:
            heard.append(sc.input_transcription.text)
        if sc and sc.turn_complete:
            break
    return "".join(heard).strip()


async def try_model(model, pcm):
    t0 = time.perf_counter()
    try:
        async with asyncio.timeout(TIMEOUT_S):
            async with client.aio.live.connect(model=model, config=make_config()) as s:
                async with asyncio.TaskGroup() as tg:
                    tg.create_task(send_audio(s, pcm, t0))
                    rec = tg.create_task(recv_transcript(s, t0))
                heard = rec.result()
        print(f"OK   {model} ({time.perf_counter() - t0:.1f}s): {heard!r}")
    except BaseException as e:  # noqa: BLE001
        if isinstance(e, BaseExceptionGroup):
            e = e.exceptions[0]
        print(f"FAIL {model}: {type(e).__name__}: {str(e)[:150]}")


async def main():
    pcm = read_wav(WAV_PATH)
    for model in MODELS:
        await try_model(model, pcm)


asyncio.run(main())