// The Cloudflare Worker for Planes Above Me.
//
// Website files (public/) are served by Cloudflare automatically. This Worker handles:
//   GET  /api/states?lamin&lomin&lamax&lomax  aircraft in a box (OpenSky "states" format)
//   GET  /api/find?callsign=UAE5 | ?hex=896181  find one aircraft anywhere in the world
//   POST /api/visit                           count a visit (day + country only)
//   POST /api/log                             error report from a visitor's browser
//   POST /api/spot                            add a spotted aircraft type to the leaderboard
//   GET  /api/stats                           visitors, busiest skies, leaderboard
//   GET  /over/<city>                         the site, preset to a city (for sharing/search)
//
// Why not call OpenSky directly? OpenSky does not let browsers on other sites read its
// answers (CORS), and it blocks requests from Cloudflare's servers. So this asks adsb.lol
// instead: free, no key, worldwide. (adsb.fi was tried too, but blocks Cloudflare.)

import { parseBox, snapQuery, toOpenSkyState, cleanNick, cleanType, CITIES } from "./lib.js";

const ADSB_LOL = "https://api.adsb.lol/v2";
const UA = { "User-Agent": "planes-above-me (hobby project; https://planes-above-me.binethwise.workers.dev)" };
const CACHE_MS = 8000; // share one upstream answer for 8 s between nearby visitors
const STALE_MS = 120000; // if adsb.lol is busy, serve an answer up to 2 min old
const RATE_PER_MIN = 40; // requests per visitor (IP) per minute, per Worker instance

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

// In-memory caches live as long as this Worker instance (usually minutes).
const answers = new Map(); // query key -> { time, body }
const hits = new Map(); // ip -> { minute, n }
const skyWrites = new Map(); // area -> last write time

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/states") return await states(request, url, env, ctx);
      if (path === "/api/find") return await find(url);
      if (path === "/api/visit" && request.method === "POST") return await visit(request, env);
      if (path === "/api/log" && request.method === "POST") return await logError(request, env);
      if (path === "/api/spot" && request.method === "POST") return await spot(request, env);
      if (path === "/api/stats") return await stats(env);
      if (path.startsWith("/over/")) return await cityPage(request, url, env);
      if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
    } catch (err) {
      console.error("worker error", path, err?.stack || err);
      return json({ error: "server error" }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------- Aircraft near a place ----------

async function states(request, url, env, ctx) {
  const box = parseBox(url.searchParams);
  if (!box) return json({ error: "missing or bad lamin/lomin/lamax/lomax" }, 400);

  // Simple per-visitor limit, so one heavy user can't use up the free data for everyone.
  if (tooMany(request.headers.get("CF-Connecting-IP") || "?")) {
    return json({ error: "too many requests from you, slow down" }, 429, { "Retry-After": "20" });
  }

  const q = snapQuery(box);
  const cached = answers.get(q.key);
  if (cached && Date.now() - cached.time < CACHE_MS) return json(cached.body, 200, { "X-Cache": "hit" });

  // Ask adsb.lol; it sometimes answers 429 "too many requests" for a moment,
  // so if the first try fails, wait 2 seconds and try once more.
  let lastStatus = 502;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${ADSB_LOL}/point/${q.lat}/${q.lon}/${q.nm}`, { headers: UA });
      if (!res.ok) { lastStatus = res.status; continue; }
      const data = await res.json();
      const body = { time: Math.floor(Date.now() / 1000), states: (data.ac || []).map(toOpenSkyState) };
      answers.set(q.key, { time: Date.now(), body });
      trimMap(answers, 500);
      ctx.waitUntil(recordSky(env, q, body.states.length));
      return json(body, 200, { "X-Cache": "miss" });
    } catch {
      lastStatus = 502;
    }
  }

  // Still failing: serve a recent answer if we have one, marked as stale.
  if (cached && Date.now() - cached.time < STALE_MS) {
    return json({ ...cached.body, stale: true }, 200, { "X-Cache": "stale" });
  }
  return json({ error: "could not get flight data" }, lastStatus);
}

function tooMany(ip) {
  const minute = Math.floor(Date.now() / 60000);
  const entry = hits.get(ip);
  if (!entry || entry.minute !== minute) { hits.set(ip, { minute, n: 1 }); trimMap(hits, 5000); return false; }
  entry.n++;
  return entry.n > RATE_PER_MIN;
}

// Remember how busy each ~1° area is (at most once per 5 minutes per area).
async function recordSky(env, q, planes) {
  if (!env.DB) return;
  const area = `${Math.round(q.lat)},${Math.round(q.lon)}`;
  if (Date.now() - (skyWrites.get(area) || 0) < 300000) return;
  skyWrites.set(area, Date.now());
  trimMap(skyWrites, 2000);
  await env.DB.prepare(
    "INSERT INTO skies (area, lat, lon, planes, ts) VALUES (?1, ?2, ?3, ?4, ?5) " +
    "ON CONFLICT(area) DO UPDATE SET lat = ?2, lon = ?3, planes = ?4, ts = ?5")
    .bind(area, q.lat, q.lon, planes, Date.now()).run().catch(() => {});
}

// ---------- Find one aircraft anywhere ----------

async function find(url) {
  const callsign = (url.searchParams.get("callsign") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const hex = (url.searchParams.get("hex") || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6);
  if (!callsign && hex.length !== 6) return json({ error: "give callsign or hex" }, 400);
  const res = await fetch(`${ADSB_LOL}/${callsign ? "callsign/" + callsign : "hex/" + hex}`, { headers: UA });
  if (!res.ok) return json({ error: "lookup failed" }, res.status);
  const data = await res.json();
  return json({ states: (data.ac || []).map(toOpenSkyState) });
}

// ---------- Stats (privacy-friendly: no IPs, no cookies, just counts) ----------

async function visit(request, env) {
  if (!env.DB) return json({ ok: false });
  const day = new Date().toISOString().slice(0, 10);
  const country = request.cf?.country || "??";
  await env.DB.prepare("INSERT INTO visits (day, country, n) VALUES (?1, ?2, 1) ON CONFLICT(day, country) DO UPDATE SET n = n + 1")
    .bind(day, country).run();
  return json({ ok: true });
}

async function logError(request, env) {
  const body = await request.json().catch(() => ({}));
  const msg = String(body.msg || "").slice(0, 500);
  if (!msg) return json({ ok: false }, 400);
  if (tooMany("log:" + (request.headers.get("CF-Connecting-IP") || "?"))) return json({ ok: false }, 429);
  console.error("browser error:", msg, body.page || "");
  if (env.DB) {
    await env.DB.prepare("INSERT INTO errors (ts, msg, page, ua) VALUES (?1, ?2, ?3, ?4)")
      .bind(Date.now(), msg, String(body.page || "").slice(0, 200), String(request.headers.get("User-Agent") || "").slice(0, 200)).run();
    // keep only the latest 1000
    await env.DB.prepare("DELETE FROM errors WHERE id <= (SELECT MAX(id) - 1000 FROM errors)").run();
  }
  return json({ ok: true });
}

async function spot(request, env) {
  const body = await request.json().catch(() => ({}));
  const nick = cleanNick(body.nick);
  const types = (Array.isArray(body.types) ? body.types : [body.type]).map(cleanType).filter(Boolean).slice(0, 50);
  if (!nick || !types.length || !env.DB) return json({ ok: false }, 400);
  if (tooMany("spot:" + (request.headers.get("CF-Connecting-IP") || "?"))) return json({ ok: false }, 429);
  const stmt = env.DB.prepare("INSERT OR IGNORE INTO spots (nick, type, ts) VALUES (?1, ?2, ?3)");
  await env.DB.batch(types.map((t) => stmt.bind(nick, t, Date.now())));
  return json({ ok: true });
}

async function stats(env) {
  if (!env.DB) return json({ error: "no database" }, 503);
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [visitsToday, visitsWeek, countries, skies, leaders, errors] = await env.DB.batch([
    env.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM visits WHERE day = ?1").bind(today),
    env.DB.prepare("SELECT day, SUM(n) AS n FROM visits WHERE day >= ?1 GROUP BY day ORDER BY day").bind(weekAgo),
    env.DB.prepare("SELECT country, SUM(n) AS n FROM visits WHERE day >= ?1 GROUP BY country ORDER BY n DESC LIMIT 15").bind(weekAgo),
    env.DB.prepare("SELECT lat, lon, planes, ts FROM skies WHERE ts > ?1 ORDER BY planes DESC LIMIT 10").bind(Date.now() - 3600000),
    env.DB.prepare("SELECT nick, COUNT(*) AS types FROM spots GROUP BY nick ORDER BY types DESC, MIN(ts) LIMIT 20"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM errors WHERE ts > ?1").bind(Date.now() - 86400000),
  ]);
  return json({
    visitsToday: visitsToday.results[0].n,
    visitsByDay: visitsWeek.results,
    countries: countries.results,
    busiestSkies: skies.results,
    leaderboard: leaders.results,
    errorsToday: errors.results[0].n,
  }, 200, { "Cache-Control": "public, max-age=30" });
}

// ---------- City pages ----------

async function cityPage(request, url, env) {
  const slug = url.pathname.split("/")[2]?.toLowerCase();
  const city = CITIES[slug];
  const page = await env.ASSETS.fetch(new Request(new URL("/", url), request));
  if (!city) return page;
  const [name, lat, lon] = city;
  const title = `Planes over ${name} right now – Planes Above Me`;
  const desc = `Live map of the aircraft flying over ${name}: airlines, routes, photos, altitude and speed.`;
  const setContent = (value) => ({ element: (el) => el.setAttribute("content", value) });
  return new HTMLRewriter()
    .on("title", { element: (el) => el.setInnerContent(title) })
    .on('meta[name="description"]', setContent(desc))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(desc))
    .on('meta[property="og:url"]', setContent(url.href))
    .on('link[rel="canonical"]', { element: (el) => el.setAttribute("href", url.href) })
    .on("head", { element: (el) => el.append(`<meta name="preset" content="${lat},${lon},${name}">`, { html: true }) })
    .transform(page);
}

function trimMap(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}
