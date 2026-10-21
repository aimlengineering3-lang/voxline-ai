import { GoogleGenAI, Modality } from "@google/genai";

const LIVE_MODEL = "gemini-3.8-live";
const TEXT_MODEL = "gemini-3.8-flash";
const VOICES = ["Achird", "Kore", "Schedar", "Sulafat"];
const DEFAULT_VOICE = "Achird";
const SYSTEM_INSTRUCTION =
  "You are Voxline, a concise and friendly voice and text assistant. " +
  "Keep answers short and natural for speech.";
const MAX_HISTORY = 20;
const MAX_TEXT = 1000;
const LOG_EVENTS = new Set([
  "turn", "skipped_turn", "interrupt", "reconnect", "error", "fallback", "session_end",
]);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// ---- guards -------------------------------------------------------------

// Best-effort per-IP sliding window (per isolate). Good enough for a free demo;
// the upgrade path is Cloudflare's Rate Limiting binding.
const buckets = new Map();
function limited(ip, name, max, windowMs = 60_000) {
  const now = Date.now();
  const key = `${name}:${ip}`;
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return true;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();
  return false;
}

// Browsers always send Origin on POST. Not a security boundary against curl,
// but it stops other websites from using this Worker as a free token vending machine.
function originAllowed(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = new Set([
    new URL(request.url).origin,
    ...(env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ]);
  return allowed.has(origin);
}

// ---- handlers -----------------------------------------------------------

async function handleToken(request, env) {
  let voice = DEFAULT_VOICE;
  try {
    const body = await request.json();
    if (body?.voice) voice = body.voice;
  } catch {
    // empty or invalid body: default voice
  }
  if (!VOICES.includes(voice)) return json({ error: "invalid_voice" }, 400);

  const ai = new GoogleGenAI({
    apiKey: env.GEMINI_API_KEY,
    httpOptions: { apiVersion: "v1alpha" },
  });

  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            systemInstruction: SYSTEM_INSTRUCTION,
            contextWindowCompression: { slidingWindow: {} },
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
            },
          },
        },
      },
    });
    console.log(JSON.stringify({ type: "mint", voice }));
    return json({ token: token.name, model: LIVE_MODEL, voice });
  } catch (err) {
    console.error("token_mint_failed:", err?.message);
    return json({ error: "token_mint_failed" }, 502);
  }
}

// Tier 2: plain text chat through the text model, seeded with the transcript
async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_TEXT) return json({ error: "invalid_message" }, 400);

  const history = Array.isArray(body?.history) ? body.history.slice(-MAX_HISTORY) : [];
  const contents = [];
  for (const t of history) {
    if ((t?.role !== "user" && t?.role !== "model") || typeof t.text !== "string") continue;
    contents.push({ role: t.role, parts: [{ text: t.text.slice(0, MAX_TEXT) }] });
  }
  contents.push({ role: "user", parts: [{ text: message }] });

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  try {
    const res = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents,
      config: { systemInstruction: SYSTEM_INSTRUCTION },
    });
    return json({ text: res.text ?? "" });
  } catch (err) {
    console.error("chat_failed:", err?.message);
    return json({ error: "chat_failed" }, 502);
  }
}

// Client telemetry sink: numbers and short enums only, never text or tokens.
async function handleLog(request) {
  const raw = await request.text();
  if (raw.length > 2000) return json({ error: "too_large" }, 413);
  let b;
  try {
    b = JSON.parse(raw);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (!LOG_EVENTS.has(b?.event)) return json({ error: "bad_event" }, 400);

  const safe = {
    type: "metric",
    event: b.event,
    sid: String(b.sid ?? "").replace(/[^a-f0-9-]/gi, "").slice(0, 36),
  };
  for (const k of ["ttfa_ms", "clear_ms", "duration_s", "attempt"]) {
    if (Number.isFinite(b[k])) safe[k] = Math.round(b[k]);
  }
  if (b.mode === "voice" || b.mode === "text") safe.mode = b.mode;
  if (typeof b.ok === "boolean") safe.ok = b.ok;
  if (typeof b.kind === "string") safe.kind = b.kind.replace(/[^a-z_]/g, "").slice(0, 40);

  console.log(JSON.stringify(safe));
  return new Response(null, { status: 204 });
}

const ROUTES = {
  "/api/token": { name: "token", max: 10, handler: handleToken },
  "/api/chat": { name: "chat", max: 20, handler: handleChat },
  "/api/log": { name: "log", max: 120, handler: handleLog },
};

export default {
  async fetch(request, env) {
    const route = ROUTES[new URL(request.url).pathname];
    if (!route) return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!originAllowed(request, env)) return json({ error: "forbidden_origin" }, 403);

    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    if (limited(ip, route.name, route.max)) return json({ error: "rate_limited" }, 429);

    return route.handler(request, env);
  },
};