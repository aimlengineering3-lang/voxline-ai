// Browser-local chat storage (localStorage). Nothing here is ever sent to a server.
const KEY = "voxline:chats:v1";
const MAX_CHATS = 20;
const MAX_MESSAGES = 200;
const MAX_TEXT = 2000;

// messages of the active chat; always mutated in place so other modules can hold a reference
export const history = [];

let chats = []; // { id, title, updated, messages: [{ role, text }] }
let currentId = null;

function clean(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages))
    .map((c) => ({
      id: c.id,
      title: typeof c.title === "string" ? c.title : "Chat",
      updated: Number.isFinite(c.updated) ? c.updated : 0,
      messages: c.messages
        .filter((m) => (m?.role === "user" || m?.role === "model") && typeof m.text === "string")
        .map((m) => ({ role: m.role, text: m.text })),
    }));
}

function read() {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    return [];
  }
}

function write() {
  try {
    const keep = chats.filter((c) => c.messages.length > 0);
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    // storage full or blocked (private mode): the app keeps working, chats just won't persist
  }
}

const byRecent = (a, b) => b.updated - a.updated;
const active = () => chats.find((c) => c.id === currentId);

export const activeId = () => currentId;

export function list() {
  return chats
    .filter((c) => c.id === currentId || c.messages.length > 0)
    .sort(byRecent)
    .map((c) => ({ id: c.id, title: c.title, count: c.messages.length }));
}

export function create() {
  const cur = active();
  if (cur && cur.messages.length === 0) return cur.id; // already on an empty chat
  const chat = { id: crypto.randomUUID(), title: "New chat", updated: Date.now(), messages: [] };
  chats.push(chat);
  currentId = chat.id;
  history.length = 0;
  return chat.id;
}

export function open(id) {
  const chat = chats.find((c) => c.id === id);
  if (!chat) return false;
  chats = chats.filter((c) => c.id === id || c.messages.length > 0);
  currentId = id;
  history.length = 0;
  history.push(...chat.messages.map((m) => ({ ...m })));
  return true;
}

export function remove(id) {
  chats = chats.filter((c) => c.id !== id);
  write();
  if (id === currentId) {
    currentId = null;
    const next = [...chats].sort(byRecent)[0];
    if (next) open(next.id);
    else create();
  }
}

export function persist() {
  const chat = active();
  if (!chat) return;
  chat.messages = history.slice(-MAX_MESSAGES).map((m) => ({
    role: m.role,
    text: m.text.slice(0, MAX_TEXT),
  }));
  const firstUser = chat.messages.find((m) => m.role === "user");
  chat.title = firstUser ? firstUser.text.slice(0, 40) : "New chat";
  if (chat.messages.length) chat.updated = Date.now();
  if (chats.length > MAX_CHATS) {
    chats.sort(byRecent);
    chats.length = MAX_CHATS;
  }
  write();
}

export function init() {
  chats = read().sort(byRecent);
  currentId = null;
  if (chats.length) open(chats[0].id);
  else create();
}