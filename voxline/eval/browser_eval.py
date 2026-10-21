"""Browser-level eval: real Chrome, real UI, fake microphone, fault injection.

Start the app first (worker + web dev servers, or pass the deployed URL):
    python eval/browser_eval.py --url http://localhost:5173 --turns 5 --drops 5 --voice
Setup once:  pip install -r requirements.txt  &&  playwright install chromium
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
READY = "document.querySelector('#status').textContent === 'Ready'"


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[max(0, -(-p * len(s) // 100) - 1)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5173")
    ap.add_argument("--turns", type=int, default=5)
    ap.add_argument("--drops", type=int, default=5)
    ap.add_argument("--voice", action="store_true", help="also run a fake-microphone voice turn")
    ap.add_argument("--wav", default=str(ROOT / "audio" / "w1.wav"))
    args = ap.parse_args()

    wav = Path(args.wav)
    if args.voice and not wav.exists():
        sys.exit(f"{wav} not found. Run run_eval.py first (it creates eval/audio/*.wav).")

    chrome_args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
    if args.voice:
        chrome_args.append(f"--use-file-for-fake-audio-capture={wav}")

    report = {"date": datetime.now(timezone.utc).isoformat(), "url": args.url}

    with sync_playwright() as p:
        browser = p.chromium.launch(args=chrome_args)
        page = browser.new_context(permissions=["microphone"]).new_page()
        page.goto(args.url)
        page.uncheck("#speak")  # headless Chrome has no audio device; skip playback
        page.click("#connect")
        page.wait_for_function(READY, timeout=30000)

        def ask(text, timeout=45000):
            n = page.evaluate("voxlineMetrics.dump().length")
            page.fill("#text", text)
            page.click("#send")
            page.wait_for_function(f"voxlineMetrics.dump().length > {n}", timeout=timeout)
            page.wait_for_function(READY, timeout=timeout)
            return page.evaluate(
                "[...document.querySelectorAll('.bubble.assistant')].at(-1)?.textContent ?? ''"
            )

        typed_failures = 0
        for _ in range(args.turns):
            try:
                ask("Give me one short fun fact about space.")
            except Exception:
                typed_failures += 1

        try:
            ask("My codeword is pineapple. Just say ok.")
        except Exception:
            pass

        drops = []
        for _ in range(args.drops):
            before = page.evaluate("voxlineMetrics.summary().reconnects")
            page.evaluate("voxlineDebug.drop()")
            try:
                page.wait_for_function(f"voxlineMetrics.summary().reconnects > {before}", timeout=40000)
                page.wait_for_function(READY, timeout=40000)
                reply = ask("What is my codeword? Answer in one word.")
                drops.append({"recovered": True, "context_kept": "pineapple" in reply.lower()})
            except Exception as e:
                drops.append({"recovered": False, "context_kept": False, "error": str(e)[:80]})

        voice = None
        if args.voice:
            page.click("#mic")
            try:
                page.wait_for_selector(".bubble.user", timeout=30000)
                page.wait_for_timeout(4000)  # let the fake mic "speak" (w1.wav is ~3.4s)
                page.click("#mic")  # stop mic -> sends audioStreamEnd
                page.wait_for_function(
                    "voxlineMetrics.dump().some(t => t.mode === 'voice')", timeout=30000
                )
                voice = {"ok": True}
            except Exception as e:
                voice = {"ok": False, "error": str(e)[:80]}

        dump = page.evaluate("voxlineMetrics.dump()")
        summary = page.evaluate("voxlineMetrics.summary()")
        browser.close()

    latency = {}
    for mode in ("text", "voice"):
        v = [t["ttfa"] for t in dump if t["mode"] == mode]
        latency[mode] = {"n": len(v), "p50_ms": pct(v, 50), "p95_ms": pct(v, 95)}

    n = len(drops)
    report.update({
        "typed_turn_failures": typed_failures,
        "ttfa": latency,
        "fault_injection": {
            "n": n,
            "recovery_rate": sum(d["recovered"] for d in drops) / n if n else None,
            "context_kept_rate": sum(d["context_kept"] for d in drops) / n if n else None,
            "rows": drops,
        },
        "voice_turn": voice,
        "client_summary": summary,
        "caveats": ["Fake microphone loops one wav file; single machine, single network. Quote n with every number."],
    })

    (ROOT / "results").mkdir(exist_ok=True)
    out = ROOT / "results" / f"browser_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"\nsaved {out}")


if __name__ == "__main__":
    main()