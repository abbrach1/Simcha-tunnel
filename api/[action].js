'use strict';

/**
 * Vercel serverless backend for Camp Simcha Arrivals.
 *
 * Serverless has no shared memory, no long-lived connections, and no disk,
 * so this runtime keeps the state in Redis (Vercel KV / Upstash — add the
 * integration so KV_REST_API_URL and KV_REST_API_TOKEN are set) and the
 * phones poll GET /api/state instead of using SSE (the frontend falls back
 * to polling automatically when the SSE endpoint isn't there).
 *
 * Writes use a compare-and-swap loop on a version key, so simultaneous
 * actions from several admin phones are applied one at a time and can never
 * corrupt each other — the same guarantee the long-running server gets from
 * its single-threaded event loop.
 */

const { defaultState, applyAction, snapshotOf } = require('../lib/logic');

const VER_KEY = 'simcha:ver';
const STATE_KEY = 'simcha:state';
const CLIENTS_KEY = 'simcha:clients';
const CLIENT_FRESH_MS = 15000;

function redisCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(cfg, ...cmd) {
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`Redis: ${j.error}`);
  return j.result;
}

// Set version+state only if the version hasn't moved since we read it.
const CAS_SCRIPT =
  "local v = redis.call('GET', KEYS[1]) "
  + "if (v or '0') == ARGV[1] then "
  + "redis.call('SET', KEYS[1], ARGV[2]) "
  + "redis.call('SET', KEYS[2], ARGV[3]) "
  + "return 1 else return 0 end";

async function readState(cfg) {
  const [ver, raw] = await redis(cfg, 'MGET', VER_KEY, STATE_KEY);
  let state = defaultState();
  if (raw) {
    try { state = { ...defaultState(), ...JSON.parse(raw) }; } catch { /* corrupt — start fresh */ }
  }
  return { ver: ver || '0', state };
}

async function applyWithCas(cfg, name, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { ver, state } = await readState(cfg);
    if (!applyAction(state, name, params)) return false;
    const ok = await redis(
      cfg, 'EVAL', CAS_SCRIPT, '2', VER_KEY, STATE_KEY,
      ver, String(Number(ver) + 1), JSON.stringify(state),
    );
    if (ok === 1) return true;
    // Someone else wrote concurrently — re-read and re-apply.
  }
  throw new Error('Too much contention, try again');
}

/** Track polling clients so the dashboard can show connected displays/admins. */
async function heartbeatAndCounts(cfg, role, id) {
  const now = Date.now();
  if (role && id) {
    await redis(cfg, 'HSET', CLIENTS_KEY, String(id).slice(0, 32), JSON.stringify({ role, ts: now }));
  }
  const flat = (await redis(cfg, 'HGETALL', CLIENTS_KEY)) || [];
  const counts = { displays: 0, dashboards: 0 };
  const stale = [];
  for (let i = 0; i < flat.length; i += 2) {
    let c = null;
    try { c = JSON.parse(flat[i + 1]); } catch { /* drop */ }
    if (c && now - c.ts < CLIENT_FRESH_MS) {
      if (c.role === 'display') counts.displays++;
      else if (c.role === 'dashboard') counts.dashboards++;
    } else if (now - ((c && c.ts) || 0) > 60000) {
      stale.push(flat[i]);
    }
  }
  if (stale.length) await redis(cfg, 'HDEL', CLIENTS_KEY, ...stale);
  return counts;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query && req.query.action) || '';
  const cfg = redisCfg();

  try {
    if (!cfg) {
      res.status(500).json({
        error: 'Storage not configured. In Vercel, add the Upstash for Redis '
          + '(or Vercel KV) integration so KV_REST_API_URL and KV_REST_API_TOKEN are set.',
      });
      return;
    }

    if (req.method === 'GET' && action === 'state') {
      const [counts, { state }] = await Promise.all([
        heartbeatAndCounts(cfg, req.query.role, req.query.id),
        readState(cfg),
      ]);
      res.status(200).json({ ...snapshotOf(state), clients: counts });
      return;
    }

    if (req.method === 'POST') {
      let params = req.body || {};
      if (typeof params === 'string') {
        try { params = JSON.parse(params); } catch { params = {}; }
      }
      const known = await applyWithCas(cfg, action, params);
      if (!known) {
        res.status(404).json({ error: 'Unknown action' });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
