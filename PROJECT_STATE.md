# Voxline: Project State (Oct 20, 2026)

## Status
Phases 0-7 code complete. Verified on real key (demo project): typed + voice chat, spoken replies,
state/status line, barge-in (server `interrupted`), context after a cut, simulated websocket drop +
auto-reconnect + context reseed, text fallback when Live fails, latency panel (voice TTFA p50 ~1.31s,
p95 ~1.67s, n=4; typed ~1.4s), chat history (new/switch/delete/persist across refresh, reseed on
Connect) — all manually tested in-browser and confirmed working.

Not yet verified: real network drop, deployment, mic quality with a good mic, 20-minute mixed session,
README results table.

## BLOCKER (new, found Oct 19-20): eval/run_eval.py's WER test is completely broken
`eval/run_eval.py --trials 3` run: WER test 0/5 cases got any response (mean_wer=1.0, empty_rate=1.0,
skipped_rate=1.0, ttfa=null for all). Context test (9/9 checks, judge 5/5) and interrupt test
(100% interrupt detection, signal p50 ~149ms/p95 ~197ms) passed fine — so this is isolated to the
WER test's audio-replay code path, not a general Live API or key problem.

Root-caused to: `run_wer()` in eval/run_eval.py streams a pre-recorded wav back to Gemini as fake
mic input via ~85 chunked `send_realtime_input()` calls over ~3.4 real seconds, THEN calls
`collect_turn()` (receive) only after the send loop finishes. This is sequential, not concurrent.

Debugging steps already done (all in a throwaway `debug_wer.py` at project root, not part of the
real codebase):
1. Same failure with both GEMINI_API_KEY (demo) and EVAL_GEMINI_API_KEY (separate project) ->
   ruled out key/project/quota issue.
2. Added `http_options=types.HttpOptions(api_version="v1alpha")` -> no change, same error.
3. Manually base64-encoded the audio chunk data before building `types.Blob(...)` -> made it WORSE
   (failed before VAD even detected activity_start; error changed from 1008 to 1011). Reverted —
   raw bytes is correct, SDK handles encoding internally.
4. Switched to concurrent send+receive via `asyncio.gather(send_audio(s, pcm), recv_messages(s, t0))`
   instead of sequential (this was the leading hypothesis, matching the working text-turn code paths
   which only ever do one quick send then receive, never an extended one-way send). Result: STILL
   fails, same way — `voice_activity_detection` reports `ACTIVITY_START` at audio_offset 0.160s,
   then connection closes with code 1008 "Requested entity was not found" (full traceback captured,
   `google.genai.errors.APIError: 1008 None. Requested entity was not found.` raised from
   `google/genai/live.py` `_receive()`). Sequential-vs-concurrent was NOT the bug either.

## Open items / known issues (unchanged from before, still true)
- Interrupt test: `context_after_cut_rate: 0.0` (0/3 trials) — after a barge-in, the follow-up
  "What did I just ask you to tell me about?" did not reference the interrupted topic in ANY trial.
  Real finding, not yet investigated. Possibly related to the documented risk "history = what was
  sent, not what was heard."
- `skipped` counter after barge-in: unverified (needs 10 spoken turns without interrupting).
- Real network drop (Wi-Fi off) untested; only `voxlineDebug.drop()`.
- Mic quality: Bluetooth earbuds gave garbage transcripts earlier; built-in laptop mic was fine.
- Speaker echo / false barge-in not stress-tested.
- Deploy (wrangler, CSP, Cloudflare signup, Workers Logs retention): all unverified.
- Rate limiter is per-isolate best effort; origin check is not a real security boundary.

## Environment
Windows 11, PowerShell, Node v24.20.0 / npm 11.19.0 (freshly installed this session — was missing on
this new device). Project root: `C:\Projects\voxline\voxline` (note: there is an OUTER
`C:\Projects\voxline` folder too — files have repeatedly been saved to the wrong one; always confirm
with `pwd`/`Test-Path` before debugging "file not found" or missing-env-var errors). Contains
worker/, web/, eval/, spikes/, .venv/. `.env` holds GEMINI_API_KEY (demo) and EVAL_GEMINI_API_KEY
(separate AI Studio project, same key prefix visible in a screenshot — SHOULD BE VERIFIED that these
are actually two different projects/keys, not a copy-paste of the same one — this was never
conclusively confirmed, though it wasn't the cause of the WER bug since both fail identically either
way). `worker/.dev.vars` holds GEMINI_API_KEY + ALLOWED_ORIGINS=http://localhost:5173.
Run: terminal 1 `cd worker; npm run dev` (needs `web/dist`: `cd web; npm run build` once), terminal 2
`cd web; npm run dev`, open http://localhost:5173.

## Architecture (unchanged)
Browser <-> Gemini Live (gemini-3.8-live) directly via one-use ephemeral tokens minted by a
Cloudflare Worker (`/api/token`). Worker also serves `/api/chat` (Tier 2 text fallback,
gemini-3.8-flash) and `/api/log` (metrics only). Vanilla JS + Vite, AudioWorklet capture (16kHz
PCM16) / playback (24kHz). Voices Achird/Kore/Schedar/Sulafat.

## Files touched this session
- Created (throwaway, NOT part of the shipped app): `debug_wer.py` at project root — minimal repro
  script for the WER audio-replay bug, currently in its "concurrent send/receive" form. Keep it
  until the bug is fixed, then delete it (it is not referenced by `.gitignore` and should not be
  committed).
- No files in `worker/`, `web/`, or `eval/` were edited this session. Earlier (prior session) the
  user had already added `web/src/chats.js` (new) and modified `web/src/main.js` + `web/index.html`
  for the chat-history feature — all since verified working in-browser.

## Next
1. **Fix the WER audio-replay bug** (blocking). Next things to try, in order:
   - Print `pcm` length and confirm it's an exact multiple of 2 bytes (sample-aligned); a misaligned
     final chunk could corrupt the stream.
   - Try sending the whole wav as ONE `send_realtime_input` call (no chunking/pacing loop) to see if
     chunking itself is the problem, independent of timing.
   - Try without `output_audio_transcription`/`input_audio_transcription` config (minimal config) to
     rule those out.
   - Check `pip show google-genai` for the installed version; search its changelog/issues for
     "1008 Requested entity was not found" + `send_realtime_input` — this may be a known SDK bug
     tied to a specific version, fixable with `pip install --upgrade google-genai` or a pin to an
     older known-good version.
   - As a fallback if unfixable soon: run WER against the **browser** eval path instead (real
     mic/speaker via Playwright fake-audio-capture in `eval/browser_eval.py --voice`), which doesn't
     go through this Python `send_realtime_input` chunking code at all, and skip/defer the
     server-side Python WER numbers for the README with a documented caveat.
2. Once WER unblocked: re-run `eval/run_eval.py --trials 3` and `eval/browser_eval.py`, capture full
   results, delete `debug_wer.py`.
3. Investigate `context_after_cut_rate: 0.0` finding (real suspected bug, see Open items).
4. Remaining failure-list checks + a 20-minute mixed session.
5. Deploy (wrangler login, `secret put GEMINI_API_KEY`, deploy), check CSP and phone.
6. Fill README results table with real numbers only, add recorded demo.
7. Explain the design at interview level (user postponed this).