import { GoogleGenAI, Modality } from "@google/genai";
import { AudioPlayer } from "./audio-player.js";
import { MicCapture } from "./mic-capture.js";
import { metrics } from "./metrics.js";
import * as chats from "./chats.js";

const MAX_RECONNECTS = 3;
const RESEED_TURNS = 12; // last N transcript entries re-sent after a reconnect or Connect
const IDLE_LIMIT_MS = 5 * 60 * 1000;
const SESSION_CAP_MS = 30 * 60 * 1000;
const VOICE_LEVEL = 0.02; // mic RMS above this counts as "user is speaking"
const MAX_TTFA_WINDOW_MS = 30000; // ignore timings older than this
const CONNECT_TIMEOUT_MS = 15000;

const els = {
  voice: document.getElementById("voice"),
  connect: document.getElementById("connect"),
  status: document.getElementById("status"),
  transcript: document.getElementById("transcript"),
  text: document.getElementById("text"),
  send: document.getElementById("send"),
  speak: document.getElementById("speak"),
  mic: document.getElementById("mic"),
  metrics: document.getElementById("metrics"),
  chats: document.getElementById("chats"),
  newchat: document.getElementById("newchat"),
  delchat: document.getElementById("delchat"),
};

const STATES = {
  disconnected: ["Disconnected", ""],
  connecting: ["Connecting...", "busy"],
  reconnecting: ["Reconnecting", "busy"],
  ready: ["Ready", "ok"],
  listening: ["Listening", "ok"],
  speech: ["Speech detected", "busy"],
  processing: ["Processing", "busy"],
  responding: ["Responding", "busy"],
  speaking: ["Speaking", "busy"],
  fallback: ["Text fallback (voice unavailable)", "error"],
};

const player = new AudioPlayer();
const micUnsupported = !navigator.mediaDevices?.getUserMedia;
let session = null;
let sessionId = 0;
let mic = null;
let userClosed = false;
let connecting = false;
let reconnecting = false;
let fallback = false;
let audioOk = true;
let idleTimer = null;
let capTimer = null;
let connectedAt = 0;
let rapidCloses = 0; // sessions that closed within seconds of opening

// transcript of the active chat (lives in chats.js, saved in this browser only)
const history = chats.history; // { role: "user" | "model", text }
let pendingUser = "";
let pendingModel = "";
let userBubble = null;
let modelBubble = null;
let turnDone = true; // server finished the current turn
let playerBusy = false; // audio still playing

// latency measurement
// typed turn: send click -> first audio chunk
// voice turn: last time the mic was loud -> first audio chunk
let typedTurn = false;
let typedStart = null;
let lastVoiceAt = 0;
let ttfaDone = false;
let turnGotOutput = false;
let interruptAt = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- UI helpers ----------

function setState(name, detail) {
  const [label, kind] = STATES[name];
  els.status.textContent = detail ? `${label} ${detail}` : label;
  els.status.dataset.kind = kind;
}

function idleState() {
  if (fallback) return setState("fallback");
  setState(playerBusy ? "speaking" : mic ? "listening" : "ready");
}

function scrollToBottom() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function addBubble(role, text = "") {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = text; // textContent, never innerHTML
  els.transcript.appendChild(div);
  scrollToBottom();
  return div;
}

const addNote = (text) => addBubble("note", text);

function updateControls() {
  const live = !!session;
  const working = connecting || reconnecting;
  const offline = !live && !working;
  els.text.disabled = !(live || fallback);
  els.send.disabled = !(live || fallback);
  els.mic.disabled = !live || micUnsupported;
  els.voice.disabled = !offline;
  els.chats.disabled = !offline;
  els.newchat.disabled = !offline;
  els.delchat.disabled = !offline;
  els.connect.disabled = working;
  els.connect.textContent = live ? "Disconnect" : fallback ? "Retry live" : "Connect";
}

function renderMetrics() {
  const m = metrics.summary();
  const sec = (v) => (v == null ? "-" : `${(v / 1000).toFixed(2)}s`);
  const ms = (v) => (v == null ? "-" : `${Math.round(v)}ms`);
  els.metrics.textContent =
    `TTFA last ${sec(m.ttfaLast)} | p50 ${sec(m.ttfaP50)} | p95 ${sec(m.ttfaP95)}` +
    ` | interrupt clear ${ms(m.clearLast)}` +
    ` | turns ${m.turns} | interrupts ${m.interrupts} | reconnects ${m.reconnects} | skipped ${m.skipped}`;
}

// ---------- chats ----------

function renderChatList() {
  els.chats.textContent = "";
  for (const c of chats.list()) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.count ? `${c.title} (${c.count})` : c.title;
    els.chats.appendChild(opt);
  }
  els.chats.value = chats.activeId();
}

function renderTranscript() {
  els.transcript.textContent = "";
  userBubble = null;
  modelBubble = null;
  pendingUser = "";
  pendingModel = "";
  for (const m of history) addBubble(m.role === "user" ? "user" : "assistant", m.text);
}

function save() {
  chats.persist();
  renderChatList();
}

function switchTo(action) {
  chats.persist();
  action();
  renderTranscript();
  renderChatList();
}

// ---------- conversation store ----------

function commitUser() {
  if (pendingUser.trim()) {
    history.push({ role: "user", text: pendingUser.trim() });
    save();
  }
  pendingUser = "";
}

function commitModel() {
  if (pendingModel.trim()) {
    history.push({ role: "model", text: pendingModel.trim() });
    save();
  }
  pendingModel = "";
}

// ---------- caps ----------

function touch() {
  clearTimeout(idleTimer);
  if (!session) return;
  idleTimer = setTimeout(() => {
    addNote("Session ended after 5 minutes of inactivity.");
    disconnect();
  }, IDLE_LIMIT_MS);
}

function startCap() {
  if (capTimer) return;
  capTimer = setTimeout(() => {
    capTimer = null;
    addNote("Maximum session length (30 minutes) reached.");
    disconnect();
  }, SESSION_CAP_MS);
}

function clearCap() {
  clearTimeout(capTimer);
  capTimer = null;
}

// ---------- player events ----------

player.onState = (s) => {
  playerBusy = s === "active";
  if (s === "idle" && interruptAt !== null) {
    metrics.interrupt(performance.now() - interruptAt);
    interruptAt = null;
    renderMetrics();
  }
  if (playerBusy) setState("speaking");
  else if (turnDone) idleState();
};

// ---------- Live messages ----------

function recordTtfa() {
  if (ttfaDone) return;
  ttfaDone = true;
  const now = performance.now();
  const start = typedTurn ? typedStart : lastVoiceAt;
  if (start && now - start < MAX_TTFA_WINDOW_MS) {
    metrics.turn(typedTurn ? "text" : "voice", now - start);
    renderMetrics();
  }
}

function handleMessage(msg) {
  if (msg.goAway) {
    console.warn("goAway:", msg.goAway);
    addNote("Session will refresh shortly.");
  }
  const sc = msg.serverContent;
  if (!sc) return;

  for (const part of sc.modelTurn?.parts ?? []) {
    if (!part.inlineData?.data) continue;
    turnGotOutput = true;
    recordTtfa();
    if (audioOk && els.speak.checked) {
      turnDone = false;
      try {
        player.enqueue(part.inlineData.data);
      } catch (err) {
        console.error("playback failed:", err);
        audioOk = false;
        metrics.error("playback");
        addNote("Audio playback failed. Replies continue as text.");
      }
    }
  }

  if (sc.inputTranscription?.text) {
    if (typedTurn) {
      // typed text may be echoed back as an "input transcription"; skip it
      console.debug("ignored input transcription during typed turn");
    } else {
      touch();
      if (!userBubble) userBubble = addBubble("user");
      userBubble.textContent += sc.inputTranscription.text;
      pendingUser += sc.inputTranscription.text;
      if (!turnGotOutput) setState("speech");
      scrollToBottom();
    }
  }

  if (sc.outputTranscription?.text) {
    turnGotOutput = true;
    turnDone = false;
    userBubble = null;
    commitUser();
    if (!modelBubble) modelBubble = addBubble("assistant");
    modelBubble.textContent += sc.outputTranscription.text;
    pendingModel += sc.outputTranscription.text;
    if (!playerBusy) setState("responding");
    scrollToBottom();
  }

  if (sc.interrupted) {
    // barge-in: drop queued audio immediately, keep what was already said
    if (playerBusy) interruptAt = performance.now();
    else metrics.interrupt(null);
    player.clear();
    playerBusy = false;
    commitModel();
    modelBubble = null;
    turnDone = false;
    turnGotOutput = false;
    ttfaDone = false; // the next answer is timed from the interrupting speech
    typedTurn = false;
    setState("speech");
    renderMetrics();
  }

  if (sc.turnComplete) {
    const hadInput = typedTurn || performance.now() - lastVoiceAt < 15000;
    if (hadInput && !turnGotOutput) {
      metrics.skipped(); // model chose not to answer (proactive audio)
    }
    turnGotOutput = false;
    ttfaDone = false;
    typedTurn = false;
    typedStart = null;
    commitUser();
    commitModel();
    userBubble = null;
    modelBubble = null;
    turnDone = true;
    touch();
    renderMetrics();
    if (!playerBusy) idleState();
  }
}

// ---------- session lifecycle ----------

async function mintToken() {
  const res = await fetch("/api/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voice: els.voice.value }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`token request failed (${res.status})`);
  return res.json();
}

async function openSession() {
  const { token, model } = await mintToken();
  const ai = new GoogleGenAI({
    apiKey: token,
    httpOptions: { apiVersion: "v1alpha" },
  });
  const id = ++sessionId;

  // The SDK's connect() can hang forever if the handshake is rejected,
  // so race it against an early-failure promise and a timeout.
  let opened = false;
  let failed = false;
  let failEarly;
  const early = new Promise((_, reject) => {
    failEarly = (err) => {
      failed = true;
      reject(err);
    };
  });
  const timer = setTimeout(
    () => failEarly(new Error("live connect timed out")),
    CONNECT_TIMEOUT_MS
  );

  const connectPromise = ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      inputAudioTranscription: {},
    },
    callbacks: {
      onopen: () => {
        opened = true;
        console.log("live session open");
      },
      onmessage: (m) => {
        if (id === sessionId) handleMessage(m);
      },
      onerror: (e) => {
        console.error("live error:", e);
        if (!opened) failEarly(new Error("live connection error"));
      },
      onclose: (e) => {
        if (!opened) failEarly(new Error(`closed before opening (${e?.code})`));
        else if (id === sessionId) handleClose(e);
      },
    },
  });

  // if we gave up but the session opens later, don't leak it
  connectPromise
    .then((s) => {
      if (failed) s.close();
    })
    .catch(() => {});

  try {
    return await Promise.race([connectPromise, early]);
  } finally {
    clearTimeout(timer);
  }
}

function reseed(s) {
  const turns = history.slice(-RESEED_TURNS).map((t) => ({
    role: t.role,
    parts: [{ text: t.text }],
  }));
  if (!turns.length) return;
  try {
    s.sendClientContent({ turns, turnComplete: false });
  } catch (err) {
    console.warn("reseed failed:", err);
    addNote("Could not restore earlier context.");
  }
}

function onLive() {
  fallback = false;
  turnDone = true;
  playerBusy = false;
  typedTurn = false;
  typedStart = null;
  ttfaDone = false;
  turnGotOutput = false;
  connectedAt = Date.now();
  startCap();
  touch();
  idleState();
  updateControls();
  els.text.focus();
}

function enterFallback() {
  session = null;
  fallback = true;
  metrics.fallback();
  stopMic();
  addNote("Live voice is unavailable right now (the demo may be busy). Continuing in text mode.");
  setState("fallback");
  updateControls();
  renderMetrics();
}

async function initAudio() {
  try {
    await player.init();
    audioOk = true;
  } catch (err) {
    console.error("audio init failed:", err);
    audioOk = false;
    metrics.error("audio_init");
    addNote("Audio playback is unavailable. Text replies still work.");
  }
}

async function connect() {
  userClosed = false;
  connecting = true;
  rapidCloses = 0;
  setState("connecting");
  updateControls();
  try {
    await initAudio(); // inside the click, so autoplay rules are satisfied
    const s = await openSession();
    session = s;
    reseed(s); // continues the selected chat; no-op on an empty chat
    if (history.length) {
      addNote("Continuing this chat (recent messages re-sent as context).");
    }
    onLive();
  } catch (err) {
    console.error(err);
    metrics.error("connect_failed");
    enterFallback();
  } finally {
    connecting = false;
    updateControls();
  }
}

function disconnect() {
  userClosed = true;
  clearTimeout(idleTimer);
  clearCap();
  if (session) {
    session.close();
  } else {
    fallback = false;
    setState("disconnected");
    updateControls();
  }
}

function handleClose(e) {
  if (!session) return; // closed while still connecting; connect() handles it
  console.log("live session closed:", e?.code, e?.reason);
  session = null;
  player.clear();
  playerBusy = false;
  commitUser();
  commitModel();
  userBubble = null;
  modelBubble = null;
  clearTimeout(idleTimer);
  updateControls();

  if (userClosed) {
    metrics.sessionEnd((Date.now() - connectedAt) / 1000);
    clearCap();
    stopMic();
    setState("disconnected");
    return;
  }

  // a session that dies within seconds of opening counts as a failed attempt,
  // so a broken model or quota cannot cause an endless reconnect loop
  rapidCloses = Date.now() - connectedAt < 5000 ? rapidCloses + 1 : 0;
  if (rapidCloses >= MAX_RECONNECTS) {
    rapidCloses = 0;
    enterFallback();
    return;
  }
  reconnect();
}

async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  updateControls();

  for (let attempt = 1; attempt <= MAX_RECONNECTS; attempt++) {
    setState("reconnecting", `(${attempt}/${MAX_RECONNECTS})`);
    await sleep(1000 * 2 ** (attempt - 1));
    if (userClosed) break;
    try {
      const s = await openSession();
      session = s;
      reseed(s);
      metrics.reconnect(attempt, true);
      addNote("Reconnected. Recent conversation re-sent as context.");
      reconnecting = false;
      onLive();
      renderMetrics();
      return;
    } catch (err) {
      console.warn(`reconnect attempt ${attempt} failed:`, err);
      metrics.reconnect(attempt, false);
    }
  }

  reconnecting = false;
  if (userClosed) {
    clearCap();
    stopMic();
    setState("disconnected");
    updateControls();
  } else {
    enterFallback();
  }
}

// ---------- sending text ----------

async function sendFallback(text) {
  setState("processing");
  const bubble = addBubble("assistant", "...");
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: history.slice(-RESEED_TURNS), message: text }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`chat failed (${res.status})`);
    const { text: reply } = await res.json();
    bubble.textContent = reply || "(empty reply)";
    history.push({ role: "user", text }, { role: "model", text: reply });
    save();
    if (reply && els.speak.checked && "speechSynthesis" in window) {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(reply));
    }
  } catch (err) {
    console.error(err);
    metrics.error("chat_failed");
    bubble.textContent = "Sorry, I couldn't get a reply. Please try again.";
  }
  scrollToBottom();
  setState("fallback");
}

async function sendText() {
  const text = els.text.value.trim();
  if (!text || !(session || fallback)) return;
  els.text.value = "";
  touch();
  addBubble("user", text);

  if (session) {
    player.clear(); // a typed turn cuts any reply still playing
    playerBusy = false;
    commitUser();
    commitModel();
    userBubble = null;
    modelBubble = null;
    history.push({ role: "user", text });
    save();
    turnDone = false;
    turnGotOutput = false;
    ttfaDone = false;
    typedTurn = true;
    typedStart = performance.now();
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    });
    setState("processing");
  } else {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    await sendFallback(text);
  }
}

// ---------- microphone ----------

async function startMic() {
  try {
    mic = new MicCapture((b64, level) => {
      if (level > VOICE_LEVEL) lastVoiceAt = performance.now();
      session?.sendRealtimeInput({
        audio: { data: b64, mimeType: "audio/pcm;rate=16000" },
      });
    });
    await mic.start();
    els.mic.textContent = "Stop mic";
    idleState();
  } catch (err) {
    console.error(err);
    metrics.error("mic");
    mic = null;
    idleState();
    addNote(
      err.name === "NotAllowedError"
        ? "Microphone permission denied. You can still type."
        : `Microphone error: ${err.message}. You can still type.`
    );
  }
}

async function stopMic() {
  if (!mic) return;
  const m = mic;
  mic = null;
  els.mic.textContent = "Start mic";
  await m.stop();
  session?.sendRealtimeInput({ audioStreamEnd: true });
  if (session) idleState();
}

// ---------- wiring ----------

els.mic.addEventListener("click", () => (mic ? stopMic() : startMic()));
els.connect.addEventListener("click", () => (session ? disconnect() : connect()));
els.send.addEventListener("click", sendText);
els.text.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendText();
});
els.chats.addEventListener("change", () => switchTo(() => chats.open(els.chats.value)));
els.newchat.addEventListener("click", () => switchTo(() => chats.create()));
els.delchat.addEventListener("click", () => {
  if (!confirm("Delete this chat from this browser?")) return;
  switchTo(() => chats.remove(chats.activeId()));
});
window.addEventListener("pagehide", () => chats.persist());
window.addEventListener("offline", () => addNote("Network connection lost."));
window.addEventListener("online", () => addNote("Network is back."));

// hooks for the browser-level eval and manual fault injection
window.voxlineMetrics = metrics;
window.voxlineDebug = { drop: () => session?.close() };

// in-app browsers (Instagram, Facebook, LinkedIn...) often block the microphone
if (/FBAN|FBAV|Instagram|Line\/|MicroMessenger|LinkedInApp|TikTok|Snapchat/i.test(navigator.userAgent)) {
  addNote("This looks like an in-app browser. Voice may be blocked here; open the link in Chrome or Safari.");
}
if (micUnsupported) addNote("This browser can't access a microphone. You can still type.");

chats.init();
renderChatList();
renderTranscript();
updateControls();
renderMetrics();