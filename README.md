# VenueMetrics backend

Sync server for the [VenueMetrics](https://dalamud.dev) FFXIV venue-analytics Dalamud plugin:
stores each night's session log in **SQLite** (a file on a volume — no separate DB server) and
computes the shared Regulars ranking so every staff member sees identical numbers. Also tracks
live plugin presence to warn when two staff track the same night.

Zero dependencies: one `server.js` on Node's built-in `node:http` + `node:sqlite`. No `npm install`.

## Deploy on Dockge

GitHub Actions builds `ghcr.io/raphsant/venuemetrics-backend:latest` (amd64 + arm64) on every push
to `main`. On your Dockge box:

1. New stack → paste [`docker-compose.yml`](docker-compose.yml).
2. In the stack's **.env**, set a long random token:
   ```
   VENUE_TOKEN=change-me-to-something-long-and-random
   ```
3. Deploy. The server listens on host port **8710**; the database lives in `./data/venue.db`
   next to the compose file (back it up by copying that file).
4. In-game: **Settings → Shared backend** → URI `http://<server>:8710` + the token → **Test connection**.

To update: re-pull the image in Dockge (`latest` tracks `main`; version tags are published for
releases tagged `v*`).

If staff connect from outside your LAN, front it with HTTPS (reverse proxy / Cloudflare tunnel)
— the token is a bearer header, don't send it over plain HTTP across the internet.

## API (all routes except `/health` need `Authorization: Bearer <VENUE_TOKEN>`)

| Route | What |
|---|---|
| `GET /health` | liveness, no auth |
| `POST /sessions[?by=Name]` | upsert one session (object) or many (array — bulk import). Dedup key: `StartedAtUtc` + `TerritoryId`. Returns `{created, updated, rejected}` |
| `GET /sessions` | night summaries, newest first |
| `GET /sessions/:id` | full session JSON |
| `GET /regulars?minNights=N&excluded=Name%0AName` | shared loyalty ranking, staff exclusions applied server-side |
| `POST /presence` | plugin heartbeat; replies `{Others:[...]}` — other live trackers (in-game overlap warning) |
| `DELETE /presence/:instanceId` | clean exit on session stop |

Presence entries expire 3 minutes after their last heartbeat.

## Run locally

```sh
VENUE_TOKEN=dev-token DB_PATH=./venue.db node server.js
```

CI runs the same smoke test on every push (see `.github/workflows/publish.yml`).
