// Everything that talks to the network, with caching so we never ask twice.
//
// - /api/states, /api/find, /api/visit, /api/log, /api/spot, /api/stats: our own Worker
// - adsbdb.com: airline, route, aircraft type (free, browser-friendly)
// - planespotters.net: aircraft photos (free; must credit the photographer)
// - Open-Meteo: weather at your location (free, no key)
// - Nominatim (OpenStreetMap): place search and town names
// - data/airports.json: airports and ATC frequencies (from OurAirports)

import { boundingBox } from "./geo.js";

const cache = new Map();
function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch(() => null));
  return cache.get(key);
}

// Be gentle with the free services: at most 3 requests at a time.
let running = 0;
const queue = [];
function gently(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => { running--; next(); }));
    next();
  });
  function next() { while (running < 3 && queue.length) { running++; queue.shift()(); } }
}
const getJson = (url) => gently(() => fetch(url).then((r) => (r.ok ? r.json() : null)));

// ---------- Aircraft positions ----------

// Returns { status, data } so the caller can tell "busy" from other errors.
export async function fetchStates(lat, lon, radiusKm) {
  const res = await fetch("/api/states?" + new URLSearchParams(boundingBox(lat, lon, radiusKm)));
  return { status: res.status, data: res.ok ? await res.json() : null };
}

export async function findFlight(query) {
  const q = query.trim().toUpperCase();
  const param = /^[0-9A-F]{6}$/.test(q) && /\d/.test(q) && !/^[A-Z]{3}\d/.test(q) ? "hex" : "callsign";
  const res = await fetch(`/api/find?${param}=${encodeURIComponent(q)}`);
  return res.ok ? (await res.json()).states || [] : [];
}

// ---------- Airline, route, aircraft, photo ----------

export const getRoute = (callsign) => cached("route:" + callsign, async () =>
  (await getJson("https://api.adsbdb.com/v0/callsign/" + encodeURIComponent(callsign)))?.response?.flightroute || null);

export const getAirline = (icao) => cached("airline:" + icao, async () => {
  const list = (await getJson("https://api.adsbdb.com/v0/airline/" + encodeURIComponent(icao)))?.response;
  return Array.isArray(list) ? list[0] : null;
});

export const getAircraft = (hex) => cached("aircraft:" + hex, async () =>
  (await getJson("https://api.adsbdb.com/v0/aircraft/" + encodeURIComponent(hex)))?.response?.aircraft || null);

export const getPhoto = (hex) => cached("photo:" + hex, async () => {
  const r = await fetch("https://api.planespotters.net/pub/photos/hex/" + encodeURIComponent(hex));
  return r.ok ? (await r.json()).photos?.[0] || null : null;
});

// Airline + route for a plane. Airline flights use callsigns like "UAE5"
// (3-letter airline code + number); private flights usually use the registration.
export function flightInfo(p) {
  return cached("info:" + p.hex + p.callsign, async () => {
    if (!p.hasCallsign) return {};
    const isAirline = /^[A-Z]{3}\d/.test(p.callsign);
    const route = isAirline ? await getRoute(p.callsign) : null;
    const airline = route?.airline || (isAirline ? await getAirline(p.callsign.slice(0, 3)) : null);
    const privateFlight = !isAirline && !!p.registration &&
      p.callsign.replace(/-/g, "") === p.registration.replace(/-/g, "").toUpperCase();
    return { route, airline, privateFlight };
  });
}

export const airlineLogo = (iata) => `https://images.kiwi.com/airlines/64/${encodeURIComponent(iata)}.png`;

// ---------- Places ----------

export async function searchPlace(text) {
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(text);
  const [hit] = (await (await fetch(url)).json()) || [];
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon), label: shortPlace(hit.display_name) } : null;
}

export async function placeName(lat, lon, lang) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=${lat}&lon=${lon}&accept-language=${lang}`;
  const a = (await (await fetch(url)).json())?.address || {};
  const town = a.city || a.town || a.village || a.suburb || a.county || a.state;
  return [town, a.country].filter(Boolean).join(", ") || null;
}

// "Colombo, Colombo District, Western Province, Sri Lanka" -> "Colombo, Sri Lanka"
export function shortPlace(name) {
  const parts = String(name).split(",").map((s) => s.trim());
  return parts.length > 2 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts.join(", ");
}

// ---------- Weather (spotting conditions) ----------

export const getWeather = (lat, lon) => cached(`wx:${lat.toFixed(1)},${lon.toFixed(1)}:${Math.floor(Date.now() / 900000)}`, async () => {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    "&current=temperature_2m,weather_code,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,is_day";
  return (await getJson(url))?.current || null;
});

// ---------- Airports ----------

export const getAirports = () => cached("airports", async () => (await fetch("/data/airports.json")).json());

// ---------- Our own stats, leaderboard and error reports ----------

export function countVisit() {
  try {
    if (sessionStorage.getItem("planes.visited")) return;
    sessionStorage.setItem("planes.visited", "1");
  } catch {}
  navigator.sendBeacon?.("/api/visit") || fetch("/api/visit", { method: "POST" }).catch(() => {});
}

let reported = 0;
export function reportError(msg) {
  if (reported++ >= 5) return; // at most 5 per visit
  const body = JSON.stringify({ msg: String(msg).slice(0, 500), page: location.pathname });
  fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
}

export async function joinLeaderboard(nick, types) {
  const res = await fetch("/api/spot", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nick, types }),
  });
  return res.ok;
}

export async function getStats() {
  const res = await fetch("/api/stats");
  return res.ok ? res.json() : null;
}
