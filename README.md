# Simcha Arrivals 🎉

A live arrival announcement board for camp. Campers stream in, one person spots
them from the gate, and the announcer by the stage reads each name off a big
screen — everything stays in sync in real time.

Two phones, two roles:

| Phone | URL | What it does |
|---|---|---|
| **Stage display** | `/display` | Fullscreen, giant auto-sizing name with a confetti pop on each new arrival. The announcer reads from this. |
| **Control dashboard** | `/dashboard` | Enter/paste the list of names, reorder them, and tap **Announce next ▶** as each camper walks in. |

Opening the root URL (`/`) shows a chooser so each phone can pick its role.

## Features

- **Real-time sync** between all phones via Server-Sent Events, with automatic
  reconnection and a visible Live / Reconnecting indicator on both screens.
- **Bulk paste**: paste the whole camper list (one name per line) in one shot,
  or add names one at a time — including while announcements are running.
- **Queue management**: reorder (↑/↓), edit (✎), remove (✕), or announce any
  name immediately out of order (📣).
- **Back / Blank screen** controls: re-show the previous name, or blank the
  display back to the welcome message between waves of arrivals.
- **Announced history** with timestamps, and one-tap **Re-queue** if a name
  needs to be announced again.
- **"Up next" strip** on the display (toggleable) so the announcer can prep
  the next name.
- **Display settings**: customize the idle title and welcome message from the
  dashboard.
- **Display screen count** on the dashboard — warns you if no stage phone is
  connected.
- **Stage-phone niceties**: tap for fullscreen, screen wake-lock so the phone
  doesn't sleep mid-event, confetti on each name (respects reduced-motion).
- **Persistence**: state is saved to `data/state.json`, so a server restart
  doesn't lose the list.
- **Keyboard shortcuts** when driving from a laptop: `Space`/`→` announce
  next, `←` go back.
- **Zero dependencies** — plain Node.js, nothing to `npm install`.

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
