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

- **Real-time sync** between all phones via Server-Sent Events, with automatic
  reconnection and a visible Live / Reconnecting indicator on both screens.
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
  doesn't lose the list. As a second layer, the dashboard phone keeps its own
  backup in the browser — if the server ever comes back empty (e.g. a cloud
  host wiped its disk on redeploy), the dashboard offers a one-tap **Restore**
  of the queue, history, and settings.
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

## How it works

- `server.js` — zero-dependency Node HTTP server. Holds the state (queue,
  current name, history, settings), exposes small `POST /api/*` actions, and
  pushes every change to all connected phones over an SSE stream (`/events`).
  State is debounce-saved to `data/state.json`.
- `public/dashboard.html` — the control UI (self-contained HTML/CSS/JS).
- `public/display.html` — the stage screen (self-contained HTML/CSS/JS).
- `public/chooser.html` — role picker served at `/`.

There is intentionally no login — keep the URL semi-private (anyone who has it
can control the board).
