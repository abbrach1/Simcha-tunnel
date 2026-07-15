#!/usr/bin/env node
/**
 * Simcha Arrivals — live announcement board.
 *
 * Zero-dependency Node.js server:
 *   - Serves the control dashboard, the stage display, and a role chooser.
 *   - Syncs all connected phones in real time via Server-Sent Events (SSE).
 *   - Persists state to disk so a restart doesn't lose the name list.
 *
 * Run with:  node server.js   (PORT env var optional, defaults to 3000)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const defaultState = () => ({
  title: 'Camp Simcha',
  idleMessage: 'Waiting for the next arrival',
  showUpNext: true,
  theme: 'dark',          // 'dark' | 'light' — light is for outdoor daylight
  // The screen has two independent slots: an arrival and a counselor call
  // can be shown at the same time, each in its own section.
  currentArrival: null,   // { id, name, at } arrival on screen
  currentCall: null,      // { id, name, at } counselor call on screen
  queue: [],              // arrivals waiting to be announced [{ id, name }]
  announced: [],          // arrivals already announced [{ id, name, at }] (newest first)
  callQueue: [],          // counselor calls waiting [{ id, name }]
  callAnnounced: [],      // counselor calls already shown [{ id, name, at }]
  // 0 only on a truly fresh server (never touched). Lets clients tell
  // "server lost its data" (auto-restore) apart from "staff cleared it".
  lastActivityAt: 0,
});

// The two announcement channels share all queue mechanics; either one's
// "next"/"show" takes over the single screen (state.current).
const LISTS = {
  arrivals: { q: 'queue', a: 'announced', cur: 'currentArrival' },
  calls: { q: 'callQueue', a: 'callAnnounced', cur: 'currentCall' },
};
const listOf = (name) => LISTS[name] || LISTS.arrivals;

let state = defaultState();

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    state = { ...defaultState(), ...saved };
  } catch {
    /* first run or unreadable file — start fresh */
  }
}

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('Failed to save state:', err.message);
    }
  }, 250);
}

const newId = () => crypto.randomBytes(6).toString('hex');

// ---------------------------------------------------------------------------
// SSE clients
// ---------------------------------------------------------------------------

/** @type {Set<{res: http.ServerResponse, role: string}>} */
const clients = new Set();

function clientCounts() {
  let displays = 0;
  let dashboards = 0;
  for (const c of clients) {
    if (c.role === 'display') displays++;
    else if (c.role === 'dashboard') dashboards++;
  }
  return { displays, dashboards };
}

function snapshot() {
  return { ...state, clients: clientCounts() };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

function changed() {
  saveState();
  broadcast();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

// Set by restore(); any other action cancels it (see restore).
let lastRestore = null;

const actions = {
  /** Add one or more names to the end of a queue. */
  add({ names, list }) {
    const L = listOf(list);
    const items = Array.isArray(names) ? names : [names];
    for (const raw of items) {
      const name = cleanName(raw);
      if (name) state[L.q].push({ id: newId(), name });
    }
  },

  /** Rename a queued entry. */
  update({ id, name, list }) {
    const L = listOf(list);
    const item = state[L.q].find((q) => q.id === id);
    const clean = cleanName(name);
    if (item && clean) item.name = clean;
  },

  /** Remove a queued entry. */
  remove({ id, list }) {
    const L = listOf(list);
    state[L.q] = state[L.q].filter((q) => q.id !== id);
  },

  /** Move a queued entry up/down/top. */
  move({ id, dir, list }) {
    const L = listOf(list);
    const arr = state[L.q];
    const i = arr.findIndex((q) => q.id === id);
    if (i < 0) return;
    const [item] = arr.splice(i, 1);
    let j = i;
    if (dir === 'up') j = Math.max(0, i - 1);
    else if (dir === 'down') j = Math.min(arr.length, i + 1);
    else if (dir === 'top') j = 0;
    arr.splice(j, 0, item);
  },

  /** Replace queue order with the given id order (drag-reorder). */
  reorder({ ids, list }) {
    if (!Array.isArray(ids)) return;
    const L = listOf(list);
    const byId = new Map(state[L.q].map((q) => [q.id, q]));
    const next = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (item) {
        next.push(item);
        byId.delete(id);
      }
    }
    // Keep anything the client didn't know about (added concurrently).
    for (const item of byId.values()) next.push(item);
    state[L.q] = next;
  },

  /**
   * Put the next queued name on the screen (taking it over from whatever is
   * showing). A name counts as announced the moment it goes on screen: it is
   * added to that channel's history immediately, and `current` mirrors the
   * newest history entry.
   */
  next({ list } = {}) {
    const L = listOf(list);
    if (state[L.q].length === 0) return;
    const item = state[L.q].shift();
    const entry = { id: item.id, name: item.name, at: Date.now() };
    state[L.a].unshift(entry);
    state[L.cur] = entry;
  },

  /** Put a specific queued name in its screen slot immediately. */
  show({ id, list }) {
    const L = listOf(list);
    const i = state[L.q].findIndex((q) => q.id === id);
    if (i < 0) return;
    const [item] = state[L.q].splice(i, 1);
    const entry = { id: item.id, name: item.name, at: Date.now() };
    state[L.a].unshift(entry);
    state[L.cur] = entry;
  },

  /**
   * Go back one step: undo the most recently shown entry (whichever slot is
   * newer) back to the front of its queue, and re-show that channel's
   * previous entry. If both slots are blank, re-show the most recent entry
   * from either history.
   */
  prev() {
    const a = state.currentArrival;
    const c = state.currentCall;
    let L = null;
    if (a && c) L = a.at >= c.at ? LISTS.arrivals : LISTS.calls;
    else if (a) L = LISTS.arrivals;
    else if (c) L = LISTS.calls;
    if (L) {
      const undone = state[L.a].shift();
      if (undone) state[L.q].unshift({ id: undone.id, name: undone.name });
      state[L.cur] = state[L.a][0] ? { ...state[L.a][0] } : null;
    } else {
      const la = state.announced[0];
      const lc = state.callAnnounced[0];
      if (!la && !lc) return;
      const useCalls = !la || (lc && lc.at > la.at);
      const Lx = useCalls ? LISTS.calls : LISTS.arrivals;
      state[Lx.cur] = { ...state[Lx.a][0] };
    }
  },

  /** Blank the screen — one slot or both (entries stay in their history). */
  clearScreen({ target } = {}) {
    if (target === 'arrival') state.currentArrival = null;
    else if (target === 'call') state.currentCall = null;
    else { state.currentArrival = null; state.currentCall = null; }
  },

  /** Put an announced/called name back at the front of its queue. */
  requeue({ id, list }) {
    const L = listOf(list);
    const i = state[L.a].findIndex((a) => a.id === id);
    if (i < 0) return;
    const [item] = state[L.a].splice(i, 1);
    if (state[L.cur] && state[L.cur].id === id) state[L.cur] = null;
    state[L.q].unshift({ id: item.id, name: item.name });
  },

  /**
   * Restore a full backup (sent by a dashboard phone when the server has
   * lost its state, e.g. after a redeploy on a host with an ephemeral disk).
   * Everything is sanitized; the screen comes back blank.
   */
  restore({ queue, announced, callQueue, callAnnounced, title, idleMessage, showUpNext, theme, showCurrent, at }) {
    // Only ever fill an empty server — never clobber live data. When several
    // phones reconnect after a data loss, each sends its backup timestamp:
    // for 60s after a restore, a strictly NEWER backup may replace it (so a
    // display that was offline with an old cache can't win over a fresh one).
    // Any other action cancels the window, so live edits are never undone.
    const empty = !state.currentArrival && !state.currentCall
      && !state.queue.length && !state.announced.length
      && !state.callQueue.length && !state.callAnnounced.length;
    const backupAt = Number(at) || 0;
    if (!empty) {
      const upgradable = lastRestore
        && Date.now() < lastRestore.until
        && backupAt > lastRestore.backupAt;
      if (!upgradable) return;
    }
    lastRestore = { backupAt, until: Date.now() + 60000 };

    const item = (x) => {
      const name = x && cleanName(x.name);
      return name ? { id: newId(), name } : null;
    };
    const queueOf = (arr) => arr.slice(0, 2000).map(item).filter(Boolean);
    const historyOf = (arr) => arr.slice(0, 2000)
      .map((a) => {
        const i = item(a);
        return i ? { ...i, at: Number(a.at) || Date.now() } : null;
      })
      .filter(Boolean);
    if (Array.isArray(queue)) state.queue = queueOf(queue);
    if (Array.isArray(announced)) state.announced = historyOf(announced);
    if (Array.isArray(callQueue)) state.callQueue = queueOf(callQueue);
    if (Array.isArray(callAnnounced)) state.callAnnounced = historyOf(callAnnounced);
    // Re-show exactly what was on screen before the server lost its data.
    // showCurrent: { arrival: bool, call: bool } (legacy string also accepted).
    const sc = showCurrent || {};
    const wantArrival = sc === 'arrival' || sc.arrival;
    const wantCall = sc === 'call' || sc.call;
    state.currentArrival = wantArrival && state.announced[0] ? { ...state.announced[0] } : null;
    state.currentCall = wantCall && state.callAnnounced[0] ? { ...state.callAnnounced[0] } : null;
    actions.settings({ title, idleMessage, showUpNext, theme });
  },

  /** Update display settings. */
  settings({ title, idleMessage, showUpNext, theme }) {
    if (typeof title === 'string') state.title = cleanName(title) || state.title;
    if (typeof idleMessage === 'string') state.idleMessage = String(idleMessage).trim().slice(0, 200);
    if (typeof showUpNext === 'boolean') state.showUpNext = showUpNext;
    if (theme === 'dark' || theme === 'light') state.theme = theme;
  },

  /** Reset parts of the state (both channels). */
  reset({ scope }) {
    if (scope === 'announced') {
      state.announced = [];
      state.callAnnounced = [];
    } else if (scope === 'queue') {
      state.queue = [];
      state.callQueue = [];
    } else if (scope === 'all') {
      const { title, idleMessage, showUpNext, theme } = state;
      state = { ...defaultState(), title, idleMessage, showUpNext, theme };
    }
  },
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const PAGES = {
  '/': 'chooser.html',
  '/dashboard': 'dashboard.html',
  '/display': 'display.html',
};

function serveFile(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // --- Live event stream -------------------------------------------------
  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const client = { res, role: url.searchParams.get('role') || 'unknown' };
    clients.add(client);
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    broadcast(); // update everyone's connected-device counts

    // Heartbeat as a real SSE event (comment lines are invisible to
    // EventSource) so clients can detect a silently-dead connection.
    const keepAlive = setInterval(() => {
      try {
        res.write('event: ping\ndata: {}\n\n');
      } catch {
        /* cleaned up below */
      }
    }, 10000);

    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(client);
      broadcast();
    });
    return;
  }

  // --- Actions ------------------------------------------------------------
  if (pathname.startsWith('/api/') && req.method === 'POST') {
    const name = pathname.slice('/api/'.length);
    const action = actions[name];
    if (!action) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown action' }));
      return;
    }
    try {
      const body = await readBody(req);
      const params = body ? JSON.parse(body) : {};
      if (name !== 'restore') lastRestore = null;
      action(params);
      state.lastActivityAt = Date.now();
      changed();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- State snapshot (handy for debugging) --------------------------------
  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  // --- Pages & static assets ------------------------------------------------
  if (req.method === 'GET' || req.method === 'HEAD') {
    const page = PAGES[pathname];
    serveFile(res, page || pathname.slice(1));
    return;
  }

  res.writeHead(405).end('Method not allowed');
});

loadState();
server.listen(PORT, () => {
  console.log(`\n  Camp Simcha Arrivals is running!\n`);
  console.log(`  Dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`  Display:    http://localhost:${PORT}/display\n`);
  console.log(`  Open the dashboard on the phone at the gate, and the`);
  console.log(`  display on the phone by the stage. (Use this machine's`);
  console.log(`  network IP instead of "localhost" from other devices.)\n`);
});
