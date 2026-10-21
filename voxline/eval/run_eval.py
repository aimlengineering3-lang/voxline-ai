"""Voxline evaluation harness (server-side, Gemini Live API).

Run from the project root with the venv active:
    python eval/run_eval.py --only wer
    python eval/run_eval.py --only all --trials 3

Uses a SEPARATE AI Studio project key (EVAL_GEMINI_API_KEY in .env),
never the demo's key, so eval load can't eat the demo's quota.
Needs Python 3.11+ (asyncio.TaskGroup).
"""
import argparse
import asyncio
import difflib
import json
import os
import re
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

import jiwer
import numpy as np
from dotenv import load_dotenv
from google import genai
from google.genai import types

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / ".env")

LIVE_MODEL = "gemini-3.8-live"
JUDGE_MODEL = "gemini-3.8-flash"
VOICE = "Achird"
SYSTEM_INSTRUCTION = (
    "You are Voxline, a concise and friendly voice and text assistant. "
    "Keep answers short and natural for speech."
)
CHUNK_MS = 100  # send audio in small chunks, like a live microphone
CHUNK_BYTES = 16000 * 2 * CHUNK_MS // 1000  # 16 kHz PCM16
TRAILING_SILENCE_S = 1.5  # silence before audio_stream_end so the server's VAD ends the turn
AUDIO_DIR = ROOT / "audio"
RESULTS_DIR = ROOT / "results"


# ---------- helpers ----------

def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[max(0, int(np.ceil(p / 100 * len(s))) - 1)]


def norm(text):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9' ]+", " ", text.lower())).strip()


def live_config():
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        output_audio_transcription=types.AudioTranscriptionConfig(),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        system_instruction=SYSTEM_INSTRUCTION,
        context_window_compression=types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow()
        ),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE)
            )
        ),
    )


def write_wav(path, pcm, rate):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def read_wav_16k(path):
    with wave.open(str(path), "rb") as w:
        fmt = (w.getframerate(), w.getnchannels(), w.getsampwidth())
        if fmt != (16000, 1, 2):
            raise SystemExit(f"{path} must be 16 kHz, mono, 16-bit PCM; got {fmt}")
        return w.readframes(w.getnframes())


def resample_24k_to_16k(pcm):
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    n_out = int(len(x) * 16000 / 24000)
    y = np.interp(np.linspace(0, len(x) - 1, n_out), np.arange(len(x)), x)
    return y.astype(np.int16).tobytes()


def text_turn(text):
    return types.Content(role="user", parts=[types.Part(text=text)])


async def collect_turn(session, t0, timeout=45, stop_on_generation=False):
    """Read server messages for one turn.

    Stops at turn_complete, or (if stop_on_generation) at generation_complete,
    which arrives well before turn_complete (that one can come ~ the audio's
    playback time later).
    """
    out = {
        "out": "", "inp": "", "ttfa": None, "first_audio_at": None,
        "audio_bytes": 0, "interrupted": False, "complete": False,
    }

    async def run():
        async for msg in session.receive():
            sc = msg.server_content
            if not sc:
                continue
            if sc.model_turn:
                for p in sc.model_turn.parts or []:
                    if p.inline_data and p.inline_data.data:
                        if out["first_audio_at"] is None:
                            out["first_audio_at"] = time.perf_counter()
                            out["ttfa"] = out["first_audio_at"] - t0
                        out["audio_bytes"] += len(p.inline_data.data)
            if sc.output_transcription and sc.output_transcription.text:
                out["out"] += sc.output_transcription.text
            if sc.input_transcription and sc.input_transcription.text:
                out["inp"] += sc.input_transcription.text
            if sc.interrupted:
                out["interrupted"] = True
            if sc.turn_complete:
                out["complete"] = True
            if stop_on_generation and sc.generation_complete:
                out["complete"] = True
                return

    try:
        await asyncio.wait_for(run(), timeout)
    except asyncio.TimeoutError:
        pass
    return out


# ---------- WER ----------

async def synthesize(client, text, path):
    pcm = bytearray()
    async with client.aio.live.connect(model=LIVE_MODEL, config=live_config()) as s:
        await s.send_client_content(
            turns=text_turn(f"Say exactly this sentence and nothing else: {text}"),
            turn_complete=True,
        )
        async for msg in s.receive():
            sc = msg.server_content
            if not sc:
                continue
            if sc.model_turn:
                for p in sc.model_turn.parts or []:
                    if p.inline_data and p.inline_data.data:
                        pcm.extend(p.inline_data.data)
            if sc.generation_complete:
                break  # all audio has been generated; skip the wait for turn_complete
    write_wav(path, resample_24k_to_16k(bytes(pcm)), 16000)


async def run_wer(client, cases):
    rows = []
    silence = bytes(int(16000 * 2 * TRAILING_SILENCE_S))

    for c in cases:
        wav = AUDIO_DIR / f"{c['id']}.wav"
        if not wav.exists():
            print(f"[wer] synthesizing {wav.name}")
            await synthesize(client, c["text"], wav)
        pcm = read_wav_16k(wav)
        t_end = None
        result = {}

        async with client.aio.live.connect(model=LIVE_MODEL, config=live_config()) as s:

            async def send_all():
                nonlocal t_end
                for i in range(0, len(pcm), CHUNK_BYTES):
                    await s.send_realtime_input(
                        audio=types.Blob(
                            data=pcm[i : i + CHUNK_BYTES], mime_type="audio/pcm;rate=16000"
                        )
                    )
                    await asyncio.sleep(CHUNK_MS / 1000)  # real time
                t_end = time.perf_counter()  # the spoken part is over
                for i in range(0, len(silence), CHUNK_BYTES):
                    await s.send_realtime_input(
                        audio=types.Blob(
                            data=silence[i : i + CHUNK_BYTES], mime_type="audio/pcm;rate=16000"
                        )
                    )
                    await asyncio.sleep(CHUNK_MS / 1000)
                await s.send_realtime_input(audio_stream_end=True)

            async def listen():
                result["res"] = await collect_turn(
                    s, time.perf_counter(), timeout=45, stop_on_generation=True
                )

            async with asyncio.TaskGroup() as tg:
                tg.create_task(send_all())
                tg.create_task(listen())

        res = result["res"]
        ttfa = (res["first_audio_at"] - t_end) if res["first_audio_at"] and t_end else None
        ref, hyp = norm(c["text"]), norm(res["inp"])
        wer = jiwer.wer(ref, hyp) if hyp else 1.0
        row = {
            "id": c["id"], "reference": ref, "hypothesis": hyp, "wer": wer,
            "empty": not hyp, "ttfa_s": ttfa, "answered": res["audio_bytes"] > 0,
            "audio_s": res["audio_bytes"] / 48000,  # 24 kHz, 16-bit mono
        }
        rows.append(row)
        ttfa_txt = f"{ttfa:.2f}s" if ttfa is not None else "none"
        print(f"[wer] {c['id']}: WER={wer:.2f} ttfa={ttfa_txt} audio_s={row['audio_s']:.1f}")

    ttfa_all = [r["ttfa_s"] for r in rows if r["ttfa_s"] is not None]
    n = len(rows)
    return rows, {
        "n": n,
        "mean_wer": float(np.mean([r["wer"] for r in rows])) if rows else None,
        "empty_rate": sum(r["empty"] for r in rows) / n if n else None,
        "skipped_rate": sum(not r["answered"] for r in rows) / n if n else None,
        "ttfa_p50_s": pct(ttfa_all, 50),
        "ttfa_p95_s": pct(ttfa_all, 95),
        "ttfa_definition": "seconds from the end of the spoken audio (before the trailing silence) to the first audio chunk",
    }


# ---------- context / follow-ups ----------

def run_check(chk, out, prev):
    t = chk["type"]
    if t == "non_empty":
        return bool(out.strip())
    if t == "contains_any":
        return any(x.lower() in out.lower() for x in chk["terms"])
    if t == "max_words":
        return 0 < len(out.split()) <= chk["n"]
    if t == "similar_to_previous":
        return bool(prev) and difflib.SequenceMatcher(None, norm(prev), norm(out)).ratio() >= chk["min_ratio"]
    raise ValueError(f"unknown check {t}")


def judge(client, rubric, user_text, reply):
    prompt = (
        "You are a strict evaluator.\n"
        f"Rubric: {rubric}\nUser message: {user_text}\nAssistant reply: {reply}\n"
        'Score 1-5 (5 = fully meets the rubric). Respond with JSON only: {"score": <int>, "reason": "<short>"}'
    )
    r = client.models.generate_content(
        model=JUDGE_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(response_mime_type="application/json"),
    )
    return json.loads(r.text)


async def run_context(client, cases):
    rows = []
    for c in cases:
        async with client.aio.live.connect(model=LIVE_MODEL, config=live_config()) as s:
            prev = ""
            for i, turn in enumerate(c["turns"]):
                t0 = time.perf_counter()
                await s.send_client_content(turns=text_turn(turn["say"]), turn_complete=True)
                res = await collect_turn(s, t0)
                out = res["out"]
                checks = [run_check(k, out, prev) for k in turn.get("checks", [])]
                score = None
                if "judge" in turn:
                    j = await asyncio.to_thread(judge, client, turn["judge"], turn["say"], out)
                    score = j.get("score")
                rows.append({
                    "case": c["id"], "turn": i, "say": turn["say"], "reply": out,
                    "checks": checks, "ttfa_s": res["ttfa"], "judge": score,
                })
                print(f"[context] {c['id']} turn {i}: checks={checks} judge={score}")
                prev = out

    all_checks = [x for r in rows for x in r["checks"]]
    scores = [r["judge"] for r in rows if r["judge"] is not None]
    return rows, {
        "turns": len(rows),
        "checks_passed": sum(all_checks),
        "checks_total": len(all_checks),
        "judge_mean": float(np.mean(scores)) if scores else None,
        "judge_n": len(scores),
        "judge_note": "LLM judge is a second opinion; deterministic checks come first",
    }


# ---------- interruption ----------

async def run_interrupt(client, trials):
    rows = []
    for k in range(trials):
        async with client.aio.live.connect(model=LIVE_MODEL, config=live_config()) as s:
            await s.send_client_content(
                turns=text_turn("Tell me a detailed story about a lighthouse keeper, at least ten sentences."),
                turn_complete=True,
            )
            got_audio = False
            async for msg in s.receive():
                sc = msg.server_content
                if sc and sc.model_turn and any(p.inline_data for p in (sc.model_turn.parts or [])):
                    got_audio = True
                    break
            await asyncio.sleep(1.0)  # let it speak for a moment, then cut in
            t_cut = time.perf_counter()
            await s.send_client_content(
                turns=text_turn("Stop. Begin your answer with the word Stopped, then say in a few words what I asked you to tell me about."),
                turn_complete=True,
            )

            t_int, out, done = None, "", False
            deadline = time.perf_counter() + 45
            while not done and time.perf_counter() < deadline:
                async for msg in s.receive():
                    sc = msg.server_content
                    if not sc:
                        continue
                    if sc.interrupted and t_int is None:
                        t_int = time.perf_counter() - t_cut
                    if t_int is not None and sc.output_transcription and sc.output_transcription.text:
                        out += sc.output_transcription.text
                    # the cancelled turn's own turn_complete carries no text; wait for the real answer
                    if sc.turn_complete and t_int is not None and out.strip():
                        done = True

        low = out.lower()
        # "stopped" proves the text is the new answer, not leftovers of the cancelled story
        ok = "stopped" in low and any(w in low for w in ("lighthouse", "story"))
        rows.append({"trial": k, "got_audio_first": got_audio, "interrupted": t_int is not None,
                     "interrupt_signal_s": t_int, "context_ok": ok, "reply": out})
        print(f"[interrupt] trial {k}: interrupted={t_int is not None} context_ok={ok}")

    lat = [r["interrupt_signal_s"] for r in rows if r["interrupt_signal_s"] is not None]
    n = len(rows)
    return rows, {
        "n": n,
        "interrupted_rate": sum(r["interrupted"] for r in rows) / n if n else None,
        "context_after_cut_rate": sum(r["context_ok"] for r in rows) / n if n else None,
        "interrupt_signal_p50_s": pct(lat, 50),
        "interrupt_signal_p95_s": pct(lat, 95),
        "definition": "seconds from sending the interrupting turn to the server's interrupted flag",
    }


# ---------- main ----------

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["wer", "context", "interrupt", "all"], default="all")
    ap.add_argument("--trials", type=int, default=3)
    args = ap.parse_args()

    key = os.environ.get("EVAL_GEMINI_API_KEY")
    if not key:
        sys.exit("Set EVAL_GEMINI_API_KEY in .env (use a SEPARATE AI Studio project from the demo).")
    client = genai.Client(api_key=key)
    cases = json.loads((ROOT / "data" / "cases.json").read_text(encoding="utf-8"))

    report = {
        "date": datetime.now(timezone.utc).isoformat(),
        "models": {"live": LIVE_MODEL, "judge": JUDGE_MODEL},
        "caveats": [
            "WER uses synthetic speech from the same model family (optimistic). "
            "Drop real 16 kHz mono recordings into eval/audio/<id>.wav for realistic numbers.",
            "Small n and live-API variance: quote p50/p95 together with n.",
            "The LLM judge is a second opinion only.",
        ],
        "results": {},
    }

    if args.only in ("wer", "all"):
        rows, summary = await run_wer(client, cases["wer"])
        report["results"]["wer"] = {"summary": summary, "rows": rows}
    if args.only in ("context", "all"):
        rows, summary = await run_context(client, cases["context"])
        report["results"]["context"] = {"summary": summary, "rows": rows}
    if args.only in ("interrupt", "all"):
        rows, summary = await run_interrupt(client, args.trials)
        report["results"]["interrupt"] = {"summary": summary, "rows": rows}

    RESULTS_DIR.mkdir(exist_ok=True)
    out = RESULTS_DIR / f"eval_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\n=== SUMMARY ===")
    print(json.dumps({k: v["summary"] for k, v in report["results"].items()}, indent=2))
    print(f"\nsaved {out}")


if __name__ == "__main__":
    asyncio.run(main())