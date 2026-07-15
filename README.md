# Camp Simcha Arrivals

A live arrival announcement board for Camp Simcha. Campers stream in, one person spots
them from the gate, and the announcer by the stage reads each name off a big
screen — everything stays in sync in real time.

Two phones, two roles:

| Phone | URL | What it does |
|---|---|---|
| **Stage display** | `/display` | Fullscreen, giant auto-sizing name for each arrival. The announcer reads from this. |
| **Control dashboard** | `/dashboard` | Enter/paste the list of names, reorder them, and tap **Announce next ▶** as each camper walks in. |

Opening the root URL (`/`) shows a chooser so each phone can pick its role.

## Features

- **Real-time sync** between all phones via Server-Sent Events, built to stay
  connected: retries every 0.5–3 s after a drop, a heartbeat watchdog catches
  connections that die silently (Wi-Fi blips), and it reconnects instantly
  when the network returns or the phone wakes. On reconnect the full state
  re-syncs, so nothing shown is ever stale. Both screens show a visible
  Live / Reconnecting indicator.
- **Bulk paste**: paste the whole camper list (one name per line) in one shot,
  or add names one at a time — including while announcements are running.
- **Queue management**: reorder (↑/↓), edit, remove, or announce any name
  immediately out of order (Show).
- **Counselor calls**: a second channel for paging a counselor whose camper
  has arrived. It has its own queue, "Call next counselor" button, history,
  and up-next list — and takes over the screen the same way an arrival does
  (shown with an orange "Counselor call — your camper is here" label).
  Either channel can grab the screen at any time; Back undoes across both.
- **Back / Blank screen** controls: re-show the previous name, or blank the
  display back to the welcome message between waves of arrivals.
- **Announced history** with timestamps, and one-tap **Re-queue** if a name
  needs to be announced again.
- **"Up next" list** on the display (toggleable): the upcoming names are shown
  in medium-size text under the current one, so the announcer can see who's
  coming without asking.
- **Display settings**: customize the idle title and welcome message from the
  dashboard, and switch the display between dark mode and a white outdoor
  mode (black-on-white reads much better in direct daylight).
- **Display screen count** on the dashboard — warns you if no stage phone is
  connected.
- **Stage-phone niceties**: tap for fullscreen, screen wake-lock so the phone
  doesn't sleep mid-event.
- **Persistence**: state is saved to `data/state.json`, so a server restart
  doesn't lose the list. As a second layer, both the display and the
  dashboard keep their own backup in the browser — if the server ever comes
  back empty (e.g. a cloud host wiped its disk on redeploy), whichever phone
  reconnects first silently restores everything, including re-showing the
  exact name that was on screen. A deliberate "Reset everything" is
  respected and never auto-restored (the dashboard still offers a manual
  Restore button as an undo). The display also renders its cached content
  instantly on page load, so it never sits blank waiting for the network.
- **Keyboard shortcuts** when driving from a laptop: `Space`/`→` announce
  next, `←` go back.
- **Zero dependencies** — plain Node.js, nothing to `npm install`.
- **Optimized for iPhone**: installable as a home-screen app (fullscreen,
  no browser chrome), safe-area aware around the notch/home indicator, no
  accidental zoom when typing names, and connections automatically re-sync
  when Safari comes back from the background.

## Running it

You need Node.js 18+ and both phones on a network that can reach the server.

```bash
node server.js          # or: npm start
```

Then:

1. Find the server machine's address (e.g. `http://192.168.1.42:3000` on camp
   Wi-Fi — run `ipconfig` / `ifconfig` to find the IP).
2. On the **stage phone**, open `http://<server>:3000/display` and tap once
   for fullscreen.
3. On the **spotter's phone**, open `http://<server>:3000/dashboard`, paste
   the camper list, and start tapping **Announce next ▶**.

The port defaults to `3000`; override with `PORT=8080 node server.js`.

### iPhone setup (recommended)

iPhone Safari doesn't have a fullscreen button — instead, install the site as
a home-screen app on both phones:

1. Open the URL in Safari.
2. Tap **Share** (the square with the arrow) → **Add to Home Screen** → **Add**.
3. Launch it from the new **Camp Simcha** icon — it opens fullscreen with
   no address bar.

Two more tips for the stage phone:

- The page asks the phone to stay awake automatically (iOS 16.4+), but as a
  backup set **Settings → Display & Brightness → Auto-Lock → Never** for the
  event.
- Turn the phone landscape for the biggest possible name display.

### Hosting options

- **Laptop on the camp Wi-Fi** (simplest): run `node server.js` on a laptop,
  and point both phones at the laptop's LAN IP.
- **Free cloud host** (works across networks / cellular): deploy to
  [Render](https://render.com), [Railway](https://railway.app), Fly.io, etc.
  It's a plain Node app — build command: none, start command:
  `node server.js`. Note that on hosts with ephemeral disks the saved state
  resets on redeploy; set `DATA_DIR` to a mounted volume to persist it.
- **Vercel**: supported via a separate serverless backend (`api/[action].js`
  + `vercel.json`). Vercel can't run the long-lived server (no shared memory,
  no SSE, no disk), so on Vercel the state lives in Redis and the phones
  automatically fall back from SSE to polling every 1.5 s. Setup:
  1. Import the repo into Vercel (no build command needed).
  2. In the Vercel dashboard, add the **Upstash for Redis** (or Vercel KV)
     integration to the project — this sets `KV_REST_API_URL` and
     `KV_REST_API_TOKEN` automatically. Without it, `/api/*` returns a clear
     "Storage not configured" error.
  3. Deploy. `/`, `/dashboard`, and `/display` work as usual.

  On Vercel, updates reach other phones within ~1.5 s (polling) instead of
  instantly (SSE), and simultaneous admin actions stay safe via a
  compare-and-swap write loop in Redis. The long-running `server.js` is
  still there for local / Render use — same features, same pages.

## How it works

- `lib/logic.js` — all the queue/screen/restore logic, shared by both
  runtimes below. Pure functions over a state object.
- `server.js` — zero-dependency Node HTTP server. Holds the state (queue,
  current name, history, settings), exposes small `POST /api/*` actions, and
  pushes every change to all connected phones over an SSE stream (`/events`).
  State is debounce-saved to `data/state.json`.
- `api/[action].js` — the same API as Vercel serverless functions, with
  state in Redis (Upstash / Vercel KV), compare-and-swap writes, and
  heartbeat-based connected-device counts. The frontend detects the missing
  SSE endpoint and polls `GET /api/state` instead.
- `public/dashboard.html` — the control UI (self-contained HTML/CSS/JS).
- `public/display.html` — the stage screen (self-contained HTML/CSS/JS).
- `public/chooser.html` — role picker served at `/`.

There is intentionally no login — keep the URL semi-private (anyone who has it
can control the board).
