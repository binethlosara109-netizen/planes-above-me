// Flight following: API routes and the recorder (runs every minute from a Cron Trigger,
// so a flight keeps being recorded after everyone closes the page).
//
//   POST /api/flights                 { icao24, callsign } -> start (or join) a session
//   GET  /api/flights                 sessions being followed now + recently finished
//   GET  /api/flights/:id             session, events, latest observation
//   GET  /api/flights/:id/telemetry   latest observation (fresh if the flight is active)
//   GET  /api/flights/:id/history     all recorded observations (for graphs and replay)
//   GET  /api/metar?ids=EGLL,OMDB     real airport weather (Aviation Weather Center)

import { toObservation, nextPhase, sessionStatus, sessionId, validSessionId, MAX_ACTIVE, GAP_MS } from "./flightlib.js";
import { distanceKm } from "./lib.js";

const ADSB_LOL = "https://api.adsb.lol/v2";
const ADSBDB = "https://api.adsbdb.com/v0";
const UA = { "User-Agent": "planes-above-me (hobby project; https://planes-above-me.binethwise.workers.dev)" };
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

const fresh = new Map(); // icao24 -> { time, ac } (8 s cache, shared by everyone watching)
const metars = new Map(); // ids -> { time, body }

export async function flightsApi(request, url, env, ctx) {
  if (!env.DB) return json({ error: "no database" }, 503);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "flights", id?, sub?]
  if (parts[1] === "metar") return metar(url);
  if (parts.length === 2) return request.method === "POST" ? start(request, env) : list(env);
  const id = parts[2];
  if (!validSessionId(id)) return json({ error: "bad flight id" }, 400);
  const session = await env.DB.prepare("SELECT * FROM flight_sessions WHERE id = ?1").bind(id).first();
  if (!session) return json({ error: "flight not found" }, 404);
  if (!parts[3]) return details(env, session);
  if (parts[3] === "telemetry") return telemetry(env, ctx, session);
  if (parts[3] === "history") return history(env, session);
  return json({ error: "not found" }, 404);
}

// ---------- Start following ----------

async function start(request, env) {
  const body = await request.json().catch(() => ({}));
  const icao24 = String(body.icao24 || "").toLowerCase();
  if (!/^~?[0-9a-f]{6}$/.test(icao24)) return json({ error: "valid icao24 required" }, 400);

  // Someone is already following this aircraft: share that session.
  const existing = await env.DB.prepare("SELECT id FROM flight_sessions WHERE icao24 = ?1 AND status = 'active'").bind(icao24).first();
  if (existing) return json({ id: existing.id, joined: true });

  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM flight_sessions WHERE status = 'active'").first();
  if (n >= MAX_ACTIVE) return json({ error: "too many flights are being followed right now, try again later" }, 503);

  // Check the aircraft is actually being received right now.
  const ac = await fetchAircraft([icao24]).then((m) => m.get(icao24)).catch(() => null);
  const obs = ac ? toObservation(ac, Date.now()) : null;
  if (!obs) return json({ error: "this aircraft isn't being received right now" }, 404);

  const callsign = obs.callsign || String(body.callsign || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || null;
  const route = callsign ? await routeFor(callsign) : null;
  const id = sessionId(callsign, icao24);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO flight_sessions (id, icao24, callsign, registration, type_code, origin, destination, status, phase, started_at, last_seen_at, points)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?9, ?10, 1)`)
      .bind(id, icao24, callsign, obs.registration, obs.type_code, route?.origin || null, route?.destination || null,
        obs.on_ground ? "ground" : null, now, obs.ts),
    insertPoint(env, id, obs),
    env.DB.prepare("INSERT OR IGNORE INTO flight_events (session_id, ts, kind, detail, inferred) VALUES (?1, ?2, 'started', ?3, 0)")
      .bind(id, obs.ts, obs.on_ground ? "on the ground" : `${obs.alt_ft} ft`),
  ]);
  return json({ id, joined: false }, 201);
}

async function routeFor(callsign) {
  if (!/^[A-Z]{3}\d/.test(callsign)) return null;
  try {
    const r = await fetch(`${ADSBDB}/callsign/${callsign}`, { headers: UA });
    const fr = r.ok ? (await r.json())?.response?.flightroute : null;
    return fr ? {
      origin: fr.origin?.icao_code, destination: fr.destination?.icao_code,
      originPos: fr.origin && { lat: fr.origin.latitude, lon: fr.origin.longitude },
      destPos: fr.destination && { lat: fr.destination.latitude, lon: fr.destination.longitude },
    } : null;
  } catch { return null; }
}

// ---------- Read ----------

async function list(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, icao24, callsign, type_code, origin, destination, status, phase, started_at, last_seen_at, ended_at, points
     FROM flight_sessions WHERE status = 'active' OR ended_at > ?1 ORDER BY status = 'active' DESC, started_at DESC LIMIT 50`)
    .bind(Date.now() - 2 * 86400_000).all();
  return json({ flights: results }, 200, { "Cache-Control": "public, max-age=15" });
}

async function details(env, session) {
  const [events, latest] = await env.DB.batch([
    env.DB.prepare("SELECT ts, kind, detail, inferred FROM flight_events WHERE session_id = ?1 ORDER BY ts").bind(session.id),
    env.DB.prepare("SELECT * FROM track_points WHERE session_id = ?1 ORDER BY ts DESC LIMIT 1").bind(session.id),
  ]);
  return json({ session, events: events.results, latest: latest.results[0] || null });
}

async function history(env, session) {
  const { results } = await env.DB.prepare(
    "SELECT ts, lat, lon, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, source FROM track_points WHERE session_id = ?1 ORDER BY ts LIMIT 5000")
    .bind(session.id).all();
  const cache = session.status === "active" ? "no-store" : "public, max-age=3600";
  return json({ points: results }, 200, { "Cache-Control": cache });
}

// Latest observation. While the flight is active, also ask adsb.lol (cached 8 s) and record
// it, so people watching get ~10-second updates between the once-a-minute recorder runs.
async function telemetry(env, ctx, session) {
  if (session.status === "active") {
    const ac = await fetchAircraft([session.icao24]).then((m) => m.get(session.icao24)).catch(() => null);
    const obs = ac ? toObservation(ac, Date.now()) : null;
    if (obs) {
      ctx.waitUntil(record(env, session, obs).catch((e) => console.error("record", e)));
      return json({ observation: { ...obs, source: "adsb.lol" }, fresh: true, status: session.status });
    }
  }
  const latest = await env.DB.prepare("SELECT * FROM track_points WHERE session_id = ?1 ORDER BY ts DESC LIMIT 1").bind(session.id).first();
  return json({ observation: latest, fresh: false, status: session.status });
}

// ---------- Recorder (Cron Trigger, every minute) ----------

export async function recordAll(env) {
  if (!env.DB) return;
  const { results: sessions } = await env.DB.prepare("SELECT * FROM flight_sessions WHERE status = 'active' LIMIT ?1").bind(MAX_ACTIVE).all();
  if (!sessions.length) return;
  const found = await fetchAircraft(sessions.map((s) => s.icao24)).catch(() => null);
  if (!found) return; // data source down: try again next minute
  for (const s of sessions) {
    const ac = found.get(s.icao24);
    await record(env, s, ac ? toObservation(ac, Date.now()) : null).catch((e) => console.error("record", s.id, e));
  }
}

// Save one observation (or note its absence), update phase, events and status.
async function record(env, s, obs) {
  const now = Date.now();
  const prev = await env.DB.prepare("SELECT * FROM track_points WHERE session_id = ?1 ORDER BY ts DESC LIMIT 1").bind(s.id).first();
  // Nothing new? (same time, or the same position repeated with a newer timestamp)
  if (obs && prev && (obs.ts <= prev.ts || (obs.lat === prev.lat && obs.lon === prev.lon && obs.alt_ft === prev.alt_ft))) obs = null;

  const stmts = [];
  let phase = s.phase;
  if (obs) {
    const destKm = await destDistance(s, obs);
    const r = nextPhase(s.phase, prev, obs, destKm);
    phase = r.phase;
    stmts.push(insertPoint(env, s.id, obs));
    for (const e of r.events) stmts.push(insertEvent(env, s.id, e.ts, e.kind, e.detail, e.observed ? 0 : 1));
    // A gap in reception (e.g. over the ocean) is shown on the timeline.
    if (prev && obs.ts - prev.ts > GAP_MS) {
      stmts.push(insertEvent(env, s.id, prev.ts, "signal_lost", null, 0));
      stmts.push(insertEvent(env, s.id, obs.ts, "signal_regained", `${Math.round((obs.ts - prev.ts) / 60000)} min without data`, 0));
    }
  }
  // Any phase other than "ground" means it has been in the air during this session.
  const everAirborne = (s.phase != null && s.phase !== "ground") || (phase != null && phase !== "ground") ||
    !!(obs && !obs.on_ground) || !!(prev && !prev.on_ground);
  const status = sessionStatus({ startedAt: s.started_at, lastSeenAt: s.last_seen_at, everAirborne }, obs, now);
  stmts.push(env.DB.prepare(
    `UPDATE flight_sessions SET phase = ?2, last_seen_at = COALESCE(?3, last_seen_at), points = points + ?4,
       status = ?5, ended_at = CASE WHEN ?5 = 'active' THEN NULL ELSE ?6 END,
       callsign = COALESCE(callsign, ?7) WHERE id = ?1`)
    .bind(s.id, phase, obs?.ts ?? null, obs ? 1 : 0, status, now, obs?.callsign ?? null));
  await env.DB.batch(stmts);
  s.phase = phase;
}

// Distance to the destination airport (km), for "approach" detection. Cached per session.
const destCache = new Map();
async function destDistance(s, obs) {
  if (!s.destination || !s.callsign) return null;
  if (!destCache.has(s.id)) destCache.set(s.id, routeFor(s.callsign));
  const route = await destCache.get(s.id);
  return route?.destPos ? distanceKm(obs.lat, obs.lon, route.destPos.lat, route.destPos.lon) : null;
}

const insertPoint = (env, id, o) => env.DB.prepare(
  `INSERT OR IGNORE INTO track_points (session_id, ts, lat, lon, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, source)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'adsb.lol')`)
  .bind(id, o.ts, o.lat, o.lon, o.alt_ft, o.gs_kt, o.track_deg, o.vrate_fpm, o.on_ground, o.squawk);

const insertEvent = (env, id, ts, kind, detail, inferred) => env.DB.prepare(
  "INSERT OR IGNORE INTO flight_events (session_id, ts, kind, detail, inferred) VALUES (?1, ?2, ?3, ?4, ?5)")
  .bind(id, ts, kind, detail, inferred);

// One request for many aircraft: /v2/hex/a,b,c. Returns Map icao24 -> aircraft.
async function fetchAircraft(hexes) {
  const out = new Map();
  const need = hexes.filter((h) => {
    const c = fresh.get(h);
    if (c && Date.now() - c.time < 8000) { if (c.ac) out.set(h, c.ac); return false; }
    return true;
  });
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    let res = await fetch(`${ADSB_LOL}/hex/${chunk.join(",")}`, { headers: UA });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); res = await fetch(`${ADSB_LOL}/hex/${chunk.join(",")}`, { headers: UA }); }
    if (!res.ok) throw new Error("adsb.lol " + res.status);
    const data = await res.json();
    const byHex = new Map((data.ac || []).map((a) => [a.hex, a]));
    for (const h of chunk) {
      fresh.set(h, { time: Date.now(), ac: byHex.get(h) || null });
      if (byHex.get(h)) out.set(h, byHex.get(h));
    }
  }
  while (fresh.size > 500) fresh.delete(fresh.keys().next().value);
  return out;
}

// ---------- Airport weather (METAR), relayed because the source blocks browsers ----------

async function metar(url) {
  const ids = (url.searchParams.get("ids") || "").toUpperCase().split(",").filter((s) => /^[A-Z0-9]{4}$/.test(s)).slice(0, 4);
  if (!ids.length) return json({ error: "ids=ICAO,ICAO required" }, 400);
  const key = ids.join(",");
  const c = metars.get(key);
  if (c && Date.now() - c.time < 300_000) return json(c.body, 200, { "Cache-Control": "public, max-age=300" });
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${key}&format=json`, { headers: UA });
  if (!res.ok) return json({ error: "weather unavailable" }, 502);
  const raw = await res.json().catch(() => []);
  const body = { metars: raw.map((m) => ({ icao: m.icaoId, name: m.name, raw: m.rawOb, time: m.obsTime, temp: m.temp, wdir: m.wdir, wspd: m.wspd, visib: m.visib, category: m.fltCat })) };
  metars.set(key, { time: Date.now(), body });
  return json(body, 200, { "Cache-Control": "public, max-age=300" });
}
