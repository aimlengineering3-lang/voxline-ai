# Voxline: Real-time Voice & Text AI Assistant

Talk or type to the same assistant in one shared session. Streaming voice, real barge-in,
live status and transcript, graceful degradation. Runs in any modern browser on a public HTTPS URL.
Zero paid services (free tiers only).

> Live demo: https://voxline.voxline.workers.dev
> If the demo is busy or the free quota is exhausted, the app falls back to text chat.

## Architecture

    Browser --1. POST /api/token--> Cloudflare Worker (static site, token mint, text fallback, log sink)
    Browser <--2. one-use ephemeral token (model, voice, system prompt locked)--
    Browser ==3. wss direct========> Gemini Live API
    Browser --4. POST /api/log (numbers only)--> Worker logs

- **Direct browser to Gemini** with ephemeral tokens: one fewer hop and no WebSocket relay on a free host.
  The real API key never leaves the Worker. Tokens are single-use and lock the model, voice and system prompt,
  so the browser cannot tamper with them.
- **Cloudflare Worker, not a Python server:** no cold start, free tier.
- **One Live session for voice and text:** one engine, one context. A typed turn interrupts speech
  (same mechanism as barge-in).
- **Barge-in:** server-side VAD sends `interrupted`; the client flushes its playback queue immediately.
- **Context:** sliding-window compression on the server, an in-memory transcript on the client, and a reseed of
  the last N turns after reconnects or voice changes. Chat history (new/switch/delete) persists in the
  browser's localStorage only.
- **Fallback ladder:** Live voice, then reconnect (3 tries), then text chat via the Gemini text model with the shared
  transcript and browser read-aloud.
- **Frontend:** vanilla JS + Vite, AudioWorklet for capture (16 kHz PCM16) and playback (24 kHz PCM16).

## Failure handling

mic denied, no microphone, in-app browser warning, network drop, websocket loss (auto-reconnect),
token or API failure and rate limits (text fallback), audio init/playback failure (text continues),
idle timeout (5 min), session cap (30 min), message length cap (500 chars).

## Security and privacy

API key is a Worker secret. Single-use, short-lived, locked tokens. Origin check and per-IP rate limits on
all endpoints (best-effort, per isolate). CSP and security headers on static assets. No audio or transcript
storage on the server; chat text is saved only in the user's own browser. Logs contain timing numbers and
short enums only. Free-tier notice: Google may use free-tier content to improve its products (disclosed
in the UI).

## Run locally

    # Worker (terminal 1)
    cd web && npm install && npm run build
    cd ../worker && npm install && npm run dev        # needs worker/.dev.vars with GEMINI_API_KEY

    # Web (terminal 2)
    cd web && npm run dev                              # http://localhost:5173

## Deploy (Cloudflare Workers, free)

    cd web && npm run build
    cd ../worker
    npx wrangler login
    npx wrangler secret put GEMINI_API_KEY
    npx wrangler deploy

## Evaluation

Server-side harness (use a separate AI Studio project/key from the demo):

    pip install -r requirements.txt
    python eval/run_eval.py --only all --trials 5

Browser-level (Chrome, fake microphone, fault injection):

    playwright install chromium
    python eval/browser_eval.py --url http://localhost:5173 --turns 5 --drops 5 --voice

Metrics: WER and empty-transcript rate, time to first audio p50/p95, follow-up and context checks
(deterministic first, LLM judge second), interruption signal latency and context accuracy after a cut,
reconnect recovery rate. Results are written to `eval/results/`.

### Results

_Measured Oct 21, 2026 against the Gemini Live API free tier (`gemini-3.8-live`), one machine, one
network. n is small — treat as directional, not statistical; numbers are not rounded up._

| Metric | Value | n |
|---|---|---|
| WER (synthetic speech) | 0.00 (0% empty, 0% skipped turns) | 5 |
| Time to first audio p50 / p95 (typed) | 603ms / 650ms | 9 |
| Time to first audio p50 / p95 (voice) | 962ms / 1154ms | 5 |
| Context checks passed | 9/9 deterministic checks; LLM judge 5/5 | 8 turns (judge n=1) |
| Interrupt signal p50 / p95 | 147ms / 152ms | 3 |
| Context accuracy after a cut | 100% (3/3) | 3 |
| Reconnect recovery rate | 100% (3/3), context kept in 100% | 3 |

### Known limitations

Live API is in Preview and models change quickly. Free-tier concurrency is limited (about 8 sessions
measured once, on an older account — not re-verified on the current key). Speaker echo can cause false
barge-in; use headphones. Synthetic-speech WER is optimistic (same model family generates and transcribes
the test audio). The automated browser-level voice test (headless Chrome with a fake microphone) times
out, because Chromium loops the fake audio file continuously and the server never detects end-of-speech;
this is a limitation of that specific test harness, not the app — voice was verified manually in-browser
and independently confirmed by the server-side harness numbers above.

## Project status

See `PROJECT_STATE.md`.