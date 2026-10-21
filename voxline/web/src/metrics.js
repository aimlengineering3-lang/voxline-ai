// Client-side metrics: kept in memory for the latency panel, and shipped to
// /api/log as numbers and short enums only (no transcript text, no tokens).

const sid = crypto.randomUUID(); // random per page load, not tied to identity
const turns = []; // { mode, ttfa }
const clears = [];
const counts = { interrupts: 0, reconnects: 0, skipped: 0, errors: 0, fallbacks: 0 };

function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

function send(payload) {
  try {
    fetch("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid, ...payload }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // telemetry must never break the app
  }
}

export const metrics = {
  turn(mode, ttfaMs) {
    turns.push({ mode, ttfa: ttfaMs });
    send({ event: "turn", mode, ttfa_ms: ttfaMs });
  },
  skipped() {
    counts.skipped++;
    send({ event: "skipped_turn" });
  },
  interrupt(clearMs) {
    counts.interrupts++;
    if (Number.isFinite(clearMs)) clears.push(clearMs);
    send({ event: "interrupt", clear_ms: clearMs });
  },
  reconnect(attempt, ok) {
    if (ok) counts.reconnects++;
    send({ event: "reconnect", attempt, ok });
  },
  error(kind) {
    counts.errors++;
    send({ event: "error", kind });
  },
  fallback() {
    counts.fallbacks++;
    send({ event: "fallback" });
  },
  sessionEnd(seconds) {
    send({ event: "session_end", duration_s: seconds });
  },
  dump() {
    return turns.map((t) => ({ ...t }));
  },
  summary() {
    const t = turns.map((x) => x.ttfa);
    return {
      turns: turns.length,
      ttfaLast: t.length ? t[t.length - 1] : null,
      ttfaP50: pct(t, 50),
      ttfaP95: pct(t, 95),
      clearLast: clears.length ? clears[clears.length - 1] : null,
      ...counts,
    };
  },
};