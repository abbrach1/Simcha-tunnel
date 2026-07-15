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
  current: null,          // { id, name, at } currently on the big screen
  queue: [],              // [{ id, name }] waiting to be announced
  announced: [],          // [{ id, name, at }] already announced (newest first)
});

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

const actions = {
  /** Add one or more names to the end of the queue. */
  add({ names }) {
    const list = Array.isArray(names) ? names : [names];
    for (const raw of list) {
      const name = cleanName(raw);
      if (name) state.queue.push({ id: newId(), name });
    }
  },

  /** Rename a queued entry. */
  update({ id, name }) {
    const item = state.queue.find((q) => q.id === id);
    const clean = cleanName(name);
    if (item && clean) item.name = clean;
  },

  /** Remove a queued entry. */
  remove({ id }) {
    state.queue = state.queue.filter((q) => q.id !== id);
  },

  /** Move a queued entry up/down/top. */
  move({ id, dir }) {
    const i = state.queue.findIndex((q) => q.id === id);
    if (i < 0) return;
    const [item] = state.queue.splice(i, 1);
    let j = i;
    if (dir === 'up') j = Math.max(0, i - 1);
    else if (dir === 'down') j = Math.min(state.queue.length, i + 1);
    else if (dir === 'top') j = 0;
    state.queue.splice(j, 0, item);
  },

  /** Replace queue order with the given id order (drag-reorder). */
  reorder({ ids }) {
    if (!Array.isArray(ids)) return;
    const byId = new Map(state.queue.map((q) => [q.id, q]));
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
    state.queue = next;
  },

  /**
   * Announce the next name in the queue. A name counts as announced the
   * moment it goes on screen: it is added to the history immediately, and
   * `current` mirrors the newest history entry.
   */
  next() {
    if (state.queue.length === 0) return;
    const item = state.queue.shift();
    const entry = { id: item.id, name: item.name, at: Date.now() };
    state.announced.unshift(entry);
    state.current = entry;
  },

  /** Announce a specific queued name immediately. */
  show({ id }) {
    const i = state.queue.findIndex((q) => q.id === id);
    if (i < 0) return;
    const [item] = state.queue.splice(i, 1);
    const entry = { id: item.id, name: item.name, at: Date.now() };
    state.announced.unshift(entry);
    state.current = entry;
  },

  /**
   * Go back one step. If a name is on screen, undo its announcement (back
   * to the front of the queue) and re-show the one before it. If the screen
   * is blank, just re-show the most recently announced name.
   */
  prev() {
    if (state.announced.length === 0) return;
    if (state.current) {
      const undone = state.announced.shift();
      state.queue.unshift({ id: undone.id, name: undone.name });
      state.current = state.announced[0] || null;
    } else {
      state.current = state.announced[0];
    }
  },

  /** Blank the big screen (the name stays in the announced history). */
  clearScreen() {
    state.current = null;
  },

  /** Put an announced name back at the front of the queue. */
  requeue({ id }) {
    const i = state.announced.findIndex((a) => a.id === id);
    if (i < 0) return;
    const [item] = state.announced.splice(i, 1);
    if (state.current && state.current.id === id) state.current = null;
    state.queue.unshift({ id: item.id, name: item.name });
  },

  /**
   * Restore a full backup (sent by a dashboard phone when the server has
   * lost its state, e.g. after a redeploy on a host with an ephemeral disk).
   * Everything is sanitized; the screen comes back blank.
   */
  restore({ queue, announced, title, idleMessage, showUpNext, theme }) {
    const item = (x) => {
      const name = x && cleanName(x.name);
      return name ? { id: newId(), name } : null;
    };
    if (Array.isArray(queue)) {
      state.queue = queue.slice(0, 2000).map(item).filter(Boolean);
    }
    if (Array.isArray(announced)) {
      state.announced = announced.slice(0, 2000)
        .map((a) => {
          const i = item(a);
          return i ? { ...i, at: Number(a.at) || Date.now() } : null;
        })
        .filter(Boolean);
    }
    state.current = null;
    actions.settings({ title, idleMessage, showUpNext, theme });
  },

  /** Update display settings. */
  settings({ title, idleMessage, showUpNext, theme }) {
    if (typeof title === 'string') state.title = cleanName(title) || state.title;
    if (typeof idleMessage === 'string') state.idleMessage = String(idleMessage).trim().slice(0, 200);
    if (typeof showUpNext === 'boolean') state.showUpNext = showUpNext;
    if (theme === 'dark' || theme === 'light') state.theme = theme;
  },

  /** Reset parts of the state. */
  reset({ scope }) {
    if (scope === 'announced') {
      state.announced = [];
    } else if (scope === 'queue') {
      state.queue = [];
    } else if (scope === 'all') {
      const { title, idleMessage, showUpNext } = state;
      state = { ...defaultState(), title, idleMessage, showUpNext };
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

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* cleaned up below */
      }
    }, 25000);

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
      action(params);
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
