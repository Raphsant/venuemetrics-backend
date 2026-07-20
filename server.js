// VenueMetrics backend — single-file, zero-dependency Node server.
//
// Stores each night's session log in SQLite (node:sqlite, bundled with Node >= 22.5)
// and computes the Regulars ranking server-side so every staff member sees the same
// numbers. Also tracks "who is currently running a session" so a second staff member
// starting the plugin gets an overlap warning.
//
// ENV:
//   VENUE_TOKEN  (required)  shared bearer token; requests without it are rejected
//   DB_PATH      (default /data/venue.db)
//   PORT         (default 8080)

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TOKEN = process.env.VENUE_TOKEN;
if (!TOKEN) {
  console.error("VENUE_TOKEN env var is required.");
  process.exit(1);
}
const DB_PATH = process.env.DB_PATH ?? "/data/venue.db";
const PORT = Number(process.env.PORT ?? 8080);

// How long after its last heartbeat a plugin instance still counts as "running".
const PRESENCE_TTL_MS = 3 * 60 * 1000;

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY,
    started_at_utc TEXT NOT NULL,
    territory_id   INTEGER NOT NULL,
    territory_name TEXT NOT NULL,
    ended_at_utc   TEXT,
    peak           INTEGER NOT NULL,
    unique_count   INTEGER NOT NULL,
    uploaded_by    TEXT,
    json           TEXT NOT NULL,
    UNIQUE (started_at_utc, territory_id)
  );
  CREATE TABLE IF NOT EXISTS presence (
    instance_id    TEXT PRIMARY KEY,
    player         TEXT NOT NULL,
    started_at_utc TEXT NOT NULL,
    last_seen_ms   INTEGER NOT NULL
  );
`);

// ---------- regulars (port of the plugin's RegularsAnalyzer) ----------

function computeRegulars(sessions, minNights, excludedNames) {
  const excluded = new Set([...excludedNames].map((n) => n.toLowerCase()));
  const map = new Map();
  for (const s of sessions) {
    for (const v of s.Visitors ?? []) {
      if (excluded.has(v.Name.toLowerCase())) continue;
      const key = `${v.Name}@${v.World}`.toLowerCase();
      let acc = map.get(key);
      if (!acc) {
        acc = {
          Name: v.Name, World: v.World, NightsAttended: 0,
          FirstSeenUtc: v.FirstSeenUtc, LastSeenUtc: v.FirstSeenUtc,
          venueNights: new Map(),
        };
        map.set(key, acc);
      }
      acc.NightsAttended++;
      if (v.FirstSeenUtc < acc.FirstSeenUtc) acc.FirstSeenUtc = v.FirstSeenUtc;
      if (v.FirstSeenUtc > acc.LastSeenUtc) acc.LastSeenUtc = v.FirstSeenUtc;
      const venue = s.TerritoryName || "Unknown";
      acc.venueNights.set(venue, (acc.venueNights.get(venue) ?? 0) + 1);
    }
  }

  return [...map.values()]
    .filter((a) => a.NightsAttended >= Math.max(1, minNights))
    .map((a) => {
      const fav = [...a.venueNights.entries()].sort((x, y) => y[1] - x[1])[0] ?? ["Unknown", 0];
      return {
        Name: a.Name, World: a.World, NightsAttended: a.NightsAttended,
        FirstSeenUtc: a.FirstSeenUtc, LastSeenUtc: a.LastSeenUtc,
        FavoriteVenue: fav[0], FavoriteVenueNights: fav[1],
      };
    })
    .sort((x, y) =>
      y.NightsAttended - x.NightsAttended
      || (y.LastSeenUtc > x.LastSeenUtc ? 1 : y.LastSeenUtc < x.LastSeenUtc ? -1 : 0)
      || x.Name.localeCompare(y.Name, undefined, { sensitivity: "base" }));
}

// ---------- request plumbing ----------

function json(res, status, body) {
  const buf = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(buf) });
  res.end(buf);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > 20 * 1024 * 1024) throw new Error("body too large");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function upsertSession(s, uploadedBy) {
  if (!s?.StartedAtUtc || typeof s.TerritoryId !== "number" || !Array.isArray(s.Visitors))
    return { error: "not a session payload (need StartedAtUtc, TerritoryId, Visitors)" };
  const existing = db.prepare("SELECT id FROM sessions WHERE started_at_utc = ? AND territory_id = ?")
                     .get(s.StartedAtUtc, s.TerritoryId);
  db.prepare(`
    INSERT INTO sessions (started_at_utc, territory_id, territory_name, ended_at_utc, peak, unique_count, uploaded_by, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (started_at_utc, territory_id) DO UPDATE SET
      territory_name = excluded.territory_name, ended_at_utc = excluded.ended_at_utc,
      peak = excluded.peak, unique_count = excluded.unique_count,
      uploaded_by = excluded.uploaded_by, json = excluded.json
  `).run(s.StartedAtUtc, s.TerritoryId, s.TerritoryName ?? "Unknown", s.EndedAtUtc ?? null,
         s.Peak ?? 0, s.Visitors.length, uploadedBy ?? null, JSON.stringify(s));
  return { status: existing ? "updated" : "created" };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/health") return json(res, 200, { ok: true });

    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return json(res, 401, { error: "missing or wrong bearer token" });

    // POST /sessions — one session, or an array for bulk import of existing local logs.
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = await readBody(req);
      const uploadedBy = url.searchParams.get("by") ?? undefined;
      const results = { created: 0, updated: 0, rejected: 0 };
      for (const s of Array.isArray(body) ? body : [body]) {
        const r = upsertSession(s, uploadedBy);
        results[r.error ? "rejected" : r.status]++;
      }
      return json(res, 200, results);
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      const rows = db.prepare(`SELECT id, started_at_utc AS StartedAtUtc, ended_at_utc AS EndedAtUtc,
                                      territory_name AS TerritoryName, peak AS Peak,
                                      unique_count AS UniqueCount, uploaded_by AS UploadedBy
                               FROM sessions ORDER BY started_at_utc DESC`).all();
      return json(res, 200, rows);
    }

    const idMatch = url.pathname.match(/^\/sessions\/(\d+)$/);
    if (req.method === "GET" && idMatch) {
      const row = db.prepare("SELECT json FROM sessions WHERE id = ?").get(Number(idMatch[1]));
      if (!row) return json(res, 404, { error: "no such session" });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(row.json);
    }

    if (req.method === "GET" && url.pathname === "/regulars") {
      const minNights = Number(url.searchParams.get("minNights") ?? 1);
      const excluded = (url.searchParams.get("excluded") ?? "").split("\n").filter(Boolean);
      const sessions = db.prepare("SELECT json FROM sessions").all().map((r) => JSON.parse(r.json));
      return json(res, 200, {
        TotalNights: sessions.length,
        Regulars: computeRegulars(sessions, minNights, excluded),
      });
    }

    // POST /presence — heartbeat while a session runs; replies with other live trackers.
    if (req.method === "POST" && url.pathname === "/presence") {
      const b = await readBody(req);
      if (!b?.InstanceId || !b?.Player) return json(res, 400, { error: "need InstanceId and Player" });
      const now = Date.now();
      db.prepare(`INSERT INTO presence (instance_id, player, started_at_utc, last_seen_ms)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT (instance_id) DO UPDATE SET
                    player = excluded.player, started_at_utc = excluded.started_at_utc,
                    last_seen_ms = excluded.last_seen_ms`)
        .run(b.InstanceId, b.Player, b.StartedAtUtc ?? "", now);
      db.prepare("DELETE FROM presence WHERE last_seen_ms < ?").run(now - PRESENCE_TTL_MS);
      const others = db.prepare(`SELECT player AS Player, started_at_utc AS StartedAtUtc
                                 FROM presence WHERE instance_id <> ? AND last_seen_ms >= ?`)
                       .all(b.InstanceId, now - PRESENCE_TTL_MS);
      return json(res, 200, { Others: others });
    }

    const presMatch = url.pathname.match(/^\/presence\/([\w-]+)$/);
    if (req.method === "DELETE" && presMatch) {
      db.prepare("DELETE FROM presence WHERE instance_id = ?").run(presMatch[1]);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "unknown route" });
  } catch (e) {
    console.error(`${req.method} ${url.pathname} failed:`, e);
    return json(res, 400, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, () => console.log(`VenueMetrics backend on :${PORT}, db at ${DB_PATH}`));
