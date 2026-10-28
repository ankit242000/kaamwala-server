// KaamWala server — Telegram bot auto-approval backend.
// Node.js only, NO external dependencies (built-ins only: http, fs, path).
// Model: worker submits -> PENDING -> bot sends it to admin's Telegram ->
// admin writes "approve <id>" (or replies "approve") -> listing goes live
// for all customers via GET /listings (APPROVED only).
//
// Env vars (never hardcoded, never logged):
//   BOT_TOKEN      - Telegram bot token, set in the Render dashboard only.
//   ADMIN_CHAT_ID  - optional; if unset, learned from the first /start
//                    message and persisted to data/admin.json.
//   PORT           - Render sets this; defaults to 3000 locally.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const LISTINGS_FILE = path.join(DATA_DIR, 'listings.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TG_BASE = 'https://api.telegram.org';

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

let listings = readJson(LISTINGS_FILE, []);
if (!Array.isArray(listings)) listings = [];
function saveListings() { writeJson(LISTINGS_FILE, listings); }

// Admin chat: env var wins; otherwise persisted learned value.
let adminChatId = process.env.ADMIN_CHAT_ID || null;
if (!adminChatId) {
  const saved = readJson(ADMIN_FILE, {});
  if (saved && saved.chatId) adminChatId = String(saved.chatId);
}
function setAdminChatId(chatId) {
  adminChatId = String(chatId);
  writeJson(ADMIN_FILE, { chatId: adminChatId, learnedAt: new Date().toISOString() });
}

let lastUpdateId = readJson(STATE_FILE, {}).lastUpdateId || 0;
function saveState() { writeJson(STATE_FILE, { lastUpdateId }); }

function nextId() {
  let max = 1000;
  for (const l of listings) {
    const m = /^KW-(\d+)$/.exec(l.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'KW-' + (max + 1);
}

function counts() {
  return {
    total: listings.length,
    pending: listings.filter((l) => l.status === 'PENDING').length,
    approved: listings.filter((l) => l.status === 'APPROVED').length,
    rejected: listings.filter((l) => l.status === 'REJECTED').length,
  };
}

// ---- Telegram helpers (token is never logged) ----
async function tgCall(method, body) {
  const token = process.env.BOT_TOKEN;
  if (!token) return { ok: false, skipped: true, reason: 'BOT_TOKEN not set' };
  const res = await fetch(`${TG_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

async function sendToAdmin(text) {
  if (!adminChatId) {
    console.log('[telegram] admin chat unknown, message not sent (listing stays PENDING)');
    return null;
  }
  try {
    const res = await tgCall('sendMessage', { chat_id: adminChatId, text });
    if (!res.ok) console.log('[telegram] sendMessage failed, listing stays as-is');
    return res;
  } catch (err) {
    console.log('[telegram] sendMessage error:', err.message);
    return null;
  }
}

function pendingMessageText(l) {
  return [
    'Nayi worker listing (PENDING):',
    `Name: ${l.name}`,
    `Kaam: ${l.kaam}`,
    `Anubhav: ${l.saal} saal`,
    `Area: ${l.area}`,
    `Phone: ${l.phone}`,
    `ID: ${l.id}`,
    '',
    `Approve karne ke liye likho: approve ${l.id}`,
    `Reject karne ke liye likho: reject ${l.id}`,
  ].join('\n');
}

async function notifyAdmin(l) {
  if (!adminChatId) {
    console.log(`[submit] ${l.id} PENDING, admin chat unknown, Telegram not sent`);
    return;
  }
  await sendToAdmin(pendingMessageText(l));
}

// ---- Telegram polling loop ----
function extractIdFromText(text) {
  if (!text) return null;
  const m = /KW-\d+/.exec(text);
  return m ? m[0] : null;
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || typeof msg.text !== 'string') return;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  // /start: learn admin chat if not known yet.
  if (text === '/start') {
    if (!adminChatId) {
      setAdminChatId(chatId);
      await sendToAdmin('KaamWala admin connected. Pending listings yahan aayengi.');
      console.log('[telegram] admin chat learned from /start');
    } else if (chatId === adminChatId) {
      await sendToAdmin('KaamWala admin already connected. Pending listings yahan aayengi.');
    } else {
      // Do not leak admin state to strangers; just acknowledge quietly.
      try {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: 'Ye bot KaamWala admin ke liye hai.',
        });
      } catch { /* ignore */ }
    }
    return;
  }

  // Only the admin can approve/reject.
  if (!adminChatId || chatId !== adminChatId) return;

  const lower = text.toLowerCase();
  let action = null;
  let id = null;
  const approveMatch = /^approve\s+(KW-\d+)/i.exec(text);
  const rejectMatch = /^reject\s+(KW-\d+)/i.exec(text);
  if (approveMatch) { action = 'APPROVED'; id = approveMatch[1]; }
  else if (rejectMatch) { action = 'REJECTED'; id = rejectMatch[1]; }
  else if (lower === 'approve' || lower === 'reject') {
    // Replying "approve"/"reject" to a pending listing message.
    const replyText = msg.reply_to_message && msg.reply_to_message.text;
    id = extractIdFromText(replyText);
    if (id) action = lower === 'approve' ? 'APPROVED' : 'REJECTED';
  }
  if (!action || !id) return; // any other admin message: ignore, never crash.

  const listing = listings.find((l) => l.id === id);
  if (!listing) {
    await sendToAdmin(`Listing ${id} nahi mili.`);
    return;
  }
  if (listing.status === action) {
    await sendToAdmin(`Listing ${id} pehle se ${action === 'APPROVED' ? 'approved' : 'rejected'} hai.`);
    return;
  }
  listing.status = action;
  saveListings();
  await sendToAdmin(
    action === 'APPROVED'
      ? `Approved: ${id} (${listing.name}, ${listing.kaam}) — ab app me live hai.`
      : `Rejected: ${id} (${listing.name}, ${listing.kaam}).`
  );
  console.log(`[telegram] ${id} -> ${action}`);
}

async function pollLoop() {
  for (;;) {
    try {
      const token = process.env.BOT_TOKEN;
      if (!token) {
        console.log('[telegram] BOT_TOKEN not set, polling paused (retry in 30s)');
        await new Promise((r) => setTimeout(r, 30000));
        continue;
      }
      const url = `${TG_BASE}/bot${token}/getUpdates?timeout=30` +
        (lastUpdateId ? `&offset=${lastUpdateId + 1}` : '');
      const res = await fetch(url, { signal: AbortSignal.timeout(40000) });
      const data = await res.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id || 0);
          saveState();
          try {
            await handleUpdate(update);
          } catch (err) {
            console.log('[telegram] update handler error:', err.message);
          }
        }
      } else if (!data.ok) {
        console.log('[telegram] getUpdates not ok, retrying');
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (err) {
      console.log('[telegram] poll error:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---- HTTP server ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100000) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, ...counts(), adminConfigured: Boolean(adminChatId) });
    }
    if (req.method === 'GET' && url.pathname === '/listings') {
      return sendJson(res, 200, listings.filter((l) => l.status === 'APPROVED'));
    }
    if (req.method === 'GET' && url.pathname === '/pending') {
      return sendJson(res, 200, listings.filter((l) => l.status === 'PENDING'));
    }
    if (req.method === 'POST' && url.pathname === '/submit') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }
      const name = String(payload.name || '').trim();
      const kaam = String(payload.kaam || '').trim();
      const area = String(payload.area || '').trim();
      const saal = Number(payload.saal);
      const phoneRaw = String(payload.phone || '').replace(/[\s-]/g, '');
      if (!name || !kaam || !area || !Number.isFinite(saal) || saal < 0 || saal > 80) {
        return sendJson(res, 400, { ok: false, error: 'name, kaam, saal, area required and valid' });
      }
      if (!/^[0-9]{10,15}$/.test(phoneRaw)) {
        return sendJson(res, 400, { ok: false, error: 'phone must be digits only (10-15 digits)' });
      }
      const listing = {
        id: nextId(),
        name,
        kaam,
        saal,
        area,
        phone: phoneRaw,
        status: 'PENDING',
        createdAt: new Date().toISOString(),
      };
      listings.push(listing);
      saveListings();
      // Notify admin right away (async, but awaited so a failure is logged).
      await notifyAdmin(listing);
      return sendJson(res, 201, { ok: true, id: listing.id, status: listing.status });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    console.log('[http] error:', err.message);
    return sendJson(res, 500, { ok: false, error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`KaamWala server listening on port ${PORT}`);
  console.log(`Admin chat configured: ${Boolean(adminChatId)}`);
  pollLoop();
});
