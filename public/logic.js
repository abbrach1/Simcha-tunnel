/* UMD: used by Node (server.js, api/[action].js via lib/logic.js) and by the
   browser in Firebase mode (window.SimchaLogic), where Firestore transactions
   apply actions client-side. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SimchaLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * Shared state logic for Camp Simcha Arrivals.
 *
 * Used by two runtimes:
 *   - server.js — the zero-dependency long-running Node server (in-memory
 *     state, SSE broadcast, JSON file persistence)
 *   - api/[action].js — Vercel serverless functions (state in Redis,
 *     clients poll instead of SSE)
 *
 * All functions mutate the passed-in state object in place and never touch
 * any module-level mutable state, so the same code is safe in both worlds.
 */

const newId = () => {
  const g = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
  if (g && g.getRandomValues) {
    const b = new Uint8Array(6);
    g.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).slice(2, 14).padEnd(12, '0');
};
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

const defaultState = () => ({
  title: 'Camp Simcha',
  idleMessage: 'Waiting for the next arrival',
  showUpNext: true,
  theme: 'dark',          // 'dark' | 'light' — light is for outdoor daylight
  flashOn: false,         // flash the display to attract attention
  flashText: 'Waiting by the tunnel',   // band shown while flashing
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
  // Restore-upgrade window (see restore); lives in state so it also works
  // across serverless invocations.
  _lastRestore: null,
});

// The two announcement channels share all queue mechanics; each has its own
// screen slot.
const LISTS = {
  arrivals: { q: 'queue', a: 'announced', cur: 'currentArrival' },
  calls: { q: 'callQueue', a: 'callAnnounced', cur: 'currentCall' },
};
const listOf = (name) => LISTS[name] || LISTS.arrivals;

const actions = {
  /** Add one or more names to the end of a queue. */
  add(state, { names, list }) {
    const L = listOf(list);
    const items = Array.isArray(names) ? names : [names];
    for (const raw of items) {
      const name = cleanName(raw);
      if (name) state[L.q].push({ id: newId(), name });
    }
  },

  /** Rename a queued entry. */
  update(state, { id, name, list }) {
    const L = listOf(list);
    const item = state[L.q].find((q) => q.id === id);
    const clean = cleanName(name);
    if (item && clean) item.name = clean;
  },

  /** Remove a queued entry. */
  remove(state, { id, list }) {
    const L = listOf(list);
    state[L.q] = state[L.q].filter((q) => q.id !== id);
  },

  /** Move a queued entry up/down/top. */
  move(state, { id, dir, list }) {
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
  reorder(state, { ids, list }) {
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
   * Put the next queued name in its screen slot. A name counts as announced
   * the moment it goes on screen: it is added to that channel's history
   * immediately, and the slot mirrors the newest history entry.
   */
  next(state, { list } = {}) {
    const L = listOf(list);
    if (state[L.q].length === 0) return;
    const item = state[L.q].shift();
    const entry = { id: item.id, name: item.name, at: Date.now() };
    state[L.a].unshift(entry);
    state[L.cur] = entry;
  },

  /** Put a specific queued name in its screen slot immediately. */
  show(state, { id, list }) {
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
  prev(state) {
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
  clearScreen(state, { target } = {}) {
    if (target === 'arrival') state.currentArrival = null;
    else if (target === 'call') state.currentCall = null;
    else { state.currentArrival = null; state.currentCall = null; }
  },

  /** Put an announced/called name back at the front of its queue. */
  requeue(state, { id, list }) {
    const L = listOf(list);
    const i = state[L.a].findIndex((a) => a.id === id);
    if (i < 0) return;
    const [item] = state[L.a].splice(i, 1);
    if (state[L.cur] && state[L.cur].id === id) state[L.cur] = null;
    state[L.q].unshift({ id: item.id, name: item.name });
  },

  /**
   * Restore a full backup (sent by a phone when the server has lost its
   * state). Only ever fills an EMPTY server — never clobbers live data.
   * For 60s after a restore, a strictly NEWER backup may replace it (so a
   * display that was offline with an old cache can't win over a fresh one);
   * any other action cancels the window, so live edits are never undone.
   */
  restore(state, { queue, announced, callQueue, callAnnounced, title, idleMessage, showUpNext, theme, flashText, showCurrent, at }) {
    const empty = !state.currentArrival && !state.currentCall
      && !state.queue.length && !state.announced.length
      && !state.callQueue.length && !state.callAnnounced.length;
    const backupAt = Number(at) || 0;
    if (!empty) {
      const lr = state._lastRestore;
      const upgradable = lr && Date.now() < lr.until && backupAt > lr.backupAt;
      if (!upgradable) return;
    }
    state._lastRestore = { backupAt, until: Date.now() + 60000 };

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
    actions.settings(state, { title, idleMessage, showUpNext, theme, flashText });
  },

  /** Turn the attention flash on or off. */
  flash(state, { on } = {}) {
    state.flashOn = !!on;
  },

  /** Update display settings. */
  settings(state, { title, idleMessage, showUpNext, theme, flashText }) {
    if (typeof title === 'string') state.title = cleanName(title) || state.title;
    if (typeof idleMessage === 'string') state.idleMessage = String(idleMessage).trim().slice(0, 200);
    if (typeof showUpNext === 'boolean') state.showUpNext = showUpNext;
    if (theme === 'dark' || theme === 'light') state.theme = theme;
    if (typeof flashText === 'string') state.flashText = cleanName(flashText) || state.flashText;
  },

  /** Reset parts of the state (both channels). */
  reset(state, { scope }) {
    if (scope === 'announced') {
      state.announced = [];
      state.callAnnounced = [];
    } else if (scope === 'queue') {
      state.queue = [];
      state.callQueue = [];
    } else if (scope === 'all') {
      const { title, idleMessage, showUpNext, theme, flashText } = state;
      Object.assign(state, defaultState(), { title, idleMessage, showUpNext, theme, flashText });
    }
  },
};

/**
 * Apply a named action to the state (mutating it in place).
 * Returns false for unknown action names.
 */
function applyAction(state, name, params) {
  const action = actions[name];
  if (!action) return false;
  if (name !== 'restore') state._lastRestore = null;
  action(state, params || {});
  state.lastActivityAt = Date.now();
  return true;
}

/** Public snapshot of the state (internal fields stripped). */
function snapshotOf(state) {
  const { _lastRestore, ...pub } = state;
  return pub;
}

return { defaultState, applyAction, snapshotOf };
}));
