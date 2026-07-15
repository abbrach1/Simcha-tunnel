#!/usr/bin/env node
/**
 * Camp Simcha Arrivals — live announcement board.
 *
 * Zero-dependency Node.js server:
 *   - Serves the control dashboard, the stage display, and a role chooser.
 *   - Syncs all connected phones in real time via Server-Sent Events (SSE).
 *   - Persists state to disk so a restart doesn't lose the name list.
 *
 * Run with:  node server.js   (PORT env var optional, defaults to 3000)
 *
 * The state/queue logic lives in lib/logic.js, shared with the Vercel
 * serverless deployment (api/[action].js).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { defaultState, applyAction, snapshotOf } = require('./lib/logic');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

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
  return { ...snapshotOf(state), clients: clientCounts() };
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
    try {
      const body = await readBody(req);
      const params = body ? JSON.parse(body) : {};
      if (!applyAction(state, name, params)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown action' }));
        return;
      }
      changed();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- State snapshot (also the polling fallback endpoint) -----------------
  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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
