// Flight following: pure helpers (no network, no database), unit-tested in
// test/flightlib.test.js.
//
// Three kinds of information are kept apart everywhere:
//   observed  – what the aircraft transmitted (position, altitude, speed, …)
//   derived   – what we infer from it (phases, events, progress); always labelled "inferred"
//   ATC       – links to authorised listening sources only (we never record or relay audio)

import { distanceKm } from "./lib.js";

export const LOST_AFTER_MS = 3 * 3600_000; // no data for 3 h -> give up (oceans can be long)
export const GAP_MS = 5 * 60_000; // no data for 5 min -> "signal lost" event
export const MAX_SESSION_MS = 22 * 3600_000; // longest flights are ~19 h
export const WAIT_ON_GROUND_MS = 6 * 3600_000; // followed before departure: wait up to 6 h
export const MAX_ACTIVE = 30; // protect the free data and database limits

// "DLH400", "3c6444", Date -> "dlh400-3c6444-202611120930"
export function sessionId(callsign, icao24, date = new Date()) {
  const cs = String(callsign || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "unknown";
  const stamp = date.toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `${cs}-${icao24}-${stamp}`;
}

export const validSessionId = (id) => /^[a-z0-9]{1,8}-[0-9a-f~]{6,7}-\d{12}$/.test(String(id));

// adsb.lol aircraft -> one observation (feet, knots, ft/min, ms timestamps).
// Uses the time the position was actually seen, not the time we asked.
export function toObservation(a, nowMs) {
  if (a?.lat == null || a?.lon == null) return null;
  const seenPos = typeof a.seen_pos === "number" ? a.seen_pos : (a.seen ?? 0);
  const onGround = a.alt_baro === "ground";
  return {
    ts: Math.round(nowMs - seenPos * 1000),
    lat: a.lat,
    lon: a.lon,
    alt_ft: onGround ? 0 : (typeof a.alt_baro === "number" ? a.alt_baro : (typeof a.alt_geom === "number" ? a.alt_geom : null)),
    gs_kt: a.gs == null ? null : Math.round(a.gs),
    track_deg: a.track == null ? null : Math.round(a.track),
    vrate_fpm: (a.baro_rate ?? a.geom_rate) ?? null,
    on_ground: onGround ? 1 : 0,
    squawk: a.squawk ?? null,
    callsign: (a.flight || "").trim() || null,
    registration: a.r ?? null,
    type_code: a.t ?? null,
  };
}

// The phase a single observation suggests. destKm = distance to destination, if known.
export function phaseOf(o, destKm = null) {
  if (!o) return null;
  if (o.on_ground) return "ground";
  const vr = o.vrate_fpm ?? 0;
  const alt = o.alt_ft ?? 0;
  const nearDest = destKm != null && destKm < 60;
  if (vr >= 500) return "climb";
  if (vr <= -500) return alt < 10000 && nearDest ? "approach" : "descent";
  if (alt < 10000 && nearDest) return "approach";
  return alt >= 10000 ? "cruise" : "level";
}

// Given the session's current phase and the last two observations, decide the new
// phase and any events. A phase change needs two observations in a row agreeing,
// so one odd reading doesn't flip it. Returns { phase, events: [{ ts, kind, detail }] }.
export function nextPhase(current, prev, obs, destKm = null) {
  const events = [];
  if (!obs) return { phase: current, events };
  const now = phaseOf(obs, destKm);
  const before = prev ? phaseOf(prev, destKm) : null;

  // takeoff / landing come straight from the on-ground flag
  if (prev && prev.on_ground && !obs.on_ground) events.push({ ts: obs.ts, kind: "takeoff", detail: null });
  if (prev && !prev.on_ground && obs.on_ground) events.push({ ts: obs.ts, kind: "landing", detail: null });

  let phase = current;
  const confirmed = now === before || !prev;
  if (now !== current && (confirmed || now === "ground")) {
    phase = now;
    if (["climb", "cruise", "descent", "approach"].includes(now) && now !== "level") {
      events.push({ ts: obs.ts, kind: now, detail: obs.alt_ft != null ? `${obs.alt_ft} ft` : null });
    }
  }
  if (phase === "level" && current && current !== "ground") phase = current; // low level-offs keep the phase

  // observed (not inferred): emergency squawks
  if (obs.squawk && ["7500", "7600", "7700"].includes(obs.squawk) && obs.squawk !== prev?.squawk) {
    events.push({ ts: obs.ts, kind: "squawk", detail: obs.squawk, observed: true });
  }
  return { phase, events };
}

// What should happen to a session after this check?
// Returns "active" | "landed" | "lost" | "ended".
export function sessionStatus({ startedAt, lastSeenAt, everAirborne }, obs, nowMs) {
  if (obs && everAirborne && obs.on_ground && (obs.gs_kt ?? 0) < 50) return "landed";
  if (nowMs - startedAt > MAX_SESSION_MS) return "ended";
  if (!everAirborne && nowMs - startedAt > WAIT_ON_GROUND_MS) return "ended";
  const last = obs ? obs.ts : lastSeenAt ?? startedAt;
  if (nowMs - last > LOST_AFTER_MS) return "lost";
  return "active";
}

// Distance flown / to go, if the route's airports are known (derived).
export function progress(origin, dest, lat, lon) {
  if (!origin || !dest || lat == null) return null;
  const done = distanceKm(origin.lat, origin.lon, lat, lon);
  const left = distanceKm(lat, lon, dest.lat, dest.lon);
  return { doneKm: done, leftKm: left, pct: Math.max(0, Math.min(100, (done / (done + left)) * 100)) };
}

// Rough arrival estimate from distance left and ground speed (derived, labelled "estimate").
export function etaMinutes(leftKm, gsKt) {
  if (leftKm == null || !gsKt || gsKt < 100) return null;
  return Math.round((leftKm / (gsKt * 1.852)) * 60 + 8); // +8 min for approach and landing
}
