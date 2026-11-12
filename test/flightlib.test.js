import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sessionId, validSessionId, toObservation, phaseOf, nextPhase, sessionStatus, progress, etaMinutes,
  LOST_AFTER_MS, MAX_SESSION_MS,
} from "../src/flightlib.js";

const obs = (o) => ({ ts: 0, lat: 50, lon: 8, alt_ft: 0, gs_kt: 0, vrate_fpm: 0, on_ground: 0, squawk: null, ...o });

test("session ids are readable, unique per start time and validated", () => {
  const id = sessionId("DLH400 ", "3c6444", new Date("2026-11-12T09:30:45Z"));
  assert.equal(id, "dlh400-3c6444-202611120930");
  assert.ok(validSessionId(id));
  assert.ok(validSessionId(sessionId(null, "3c6444")));
  assert.equal(validSessionId("../etc"), false);
  assert.equal(validSessionId("dlh400-3c6444-2026"), false);
});

test("observation keeps the aircraft's own time and units", () => {
  const o = toObservation({ hex: "3c6444", flight: "DLH400 ", lat: 50, lon: 8, alt_baro: 35000, gs: 482.4, track: 273.6, baro_rate: -64, seen_pos: 2.5, squawk: "1000" }, 100_000);
  assert.equal(o.ts, 97_500);
  assert.equal(o.alt_ft, 35000);
  assert.equal(o.gs_kt, 482);
  assert.equal(o.track_deg, 274);
  assert.equal(o.on_ground, 0);
  assert.equal(o.callsign, "DLH400");
  assert.equal(toObservation({ hex: "x", alt_baro: 100 }, 0), null);
  assert.equal(toObservation({ lat: 1, lon: 2, alt_baro: "ground" }, 0).on_ground, 1);
});

test("phase from one observation", () => {
  assert.equal(phaseOf(obs({ on_ground: 1 })), "ground");
  assert.equal(phaseOf(obs({ alt_ft: 8000, vrate_fpm: 2500 })), "climb");
  assert.equal(phaseOf(obs({ alt_ft: 36000, vrate_fpm: 0 })), "cruise");
  assert.equal(phaseOf(obs({ alt_ft: 20000, vrate_fpm: -1800 })), "descent");
  assert.equal(phaseOf(obs({ alt_ft: 6000, vrate_fpm: -900 }), 30), "approach");
  assert.equal(phaseOf(obs({ alt_ft: 6000, vrate_fpm: -900 }), 300), "descent");
  assert.equal(phaseOf(obs({ alt_ft: 4000, vrate_fpm: 0 })), "level");
});

test("takeoff and landing come from the on-ground flag", () => {
  const up = nextPhase("ground", obs({ on_ground: 1 }), obs({ ts: 5, alt_ft: 1200, vrate_fpm: 2000 }));
  assert.deepEqual(up.events.map((e) => e.kind), ["takeoff"]);
  const down = nextPhase("approach", obs({ alt_ft: 300, vrate_fpm: -700 }), obs({ ts: 9, on_ground: 1 }), 2);
  assert.ok(down.events.some((e) => e.kind === "landing"));
  assert.equal(down.phase, "ground");
});

test("a phase change needs two observations agreeing", () => {
  const climbing = obs({ alt_ft: 30000, vrate_fpm: 1500 });
  const level = obs({ ts: 60_000, alt_ft: 35000, vrate_fpm: 0 });
  const once = nextPhase("climb", climbing, level);
  assert.equal(once.phase, "climb");
  assert.equal(once.events.length, 0);
  const twice = nextPhase("climb", level, { ...level, ts: 120_000 });
  assert.equal(twice.phase, "cruise");
  assert.deepEqual(twice.events.map((e) => e.kind), ["cruise"]);
});

test("emergency squawk is an observed event, reported once", () => {
  const a = obs({ alt_ft: 30000, squawk: "7700" });
  const r = nextPhase("cruise", obs({ alt_ft: 30000, squawk: "2000" }), a);
  assert.deepEqual(r.events.map((e) => [e.kind, e.detail, e.observed]), [["squawk", "7700", true]]);
  assert.equal(nextPhase("cruise", a, { ...a, ts: 1 }).events.length, 0);
});

test("session status: landed, lost, ended, waiting", () => {
  const now = 10 * 3600_000;
  const base = { startedAt: now - 3600_000, lastSeenAt: now - 60_000, everAirborne: true };
  assert.equal(sessionStatus(base, obs({ ts: now, on_ground: 1, gs_kt: 20 }), now), "landed");
  assert.equal(sessionStatus(base, obs({ ts: now, on_ground: 1, gs_kt: 140 }), now), "active"); // still rolling out
  assert.equal(sessionStatus({ ...base, lastSeenAt: now - LOST_AFTER_MS - 1 }, null, now), "lost");
  assert.equal(sessionStatus({ ...base, startedAt: now - MAX_SESSION_MS - 1 }, null, now), "ended");
  assert.equal(sessionStatus({ startedAt: now - 3600_000, lastSeenAt: now, everAirborne: false }, obs({ ts: now, on_ground: 1 }), now), "active");
});

test("progress and ETA", () => {
  const p = progress({ lat: 50.03, lon: 8.57 }, { lat: 40.64, lon: -73.78 }, 50.03, 8.57);
  assert.equal(Math.round(p.pct), 0);
  assert.ok(p.leftKm > 6000);
  assert.equal(progress(null, null, 1, 2), null);
  assert.equal(etaMinutes(926, 500), 68); // 1 h + 8 min
  assert.equal(etaMinutes(100, 50), null);
});
