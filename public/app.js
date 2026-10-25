// Planes Above Me – live aircraft around you, anywhere in the world.
//
// Where the data comes from:
// - Aircraft positions: this site's Cloudflare Worker (/api/states, see src/worker.js),
//   which fetches adsb.lol and answers in OpenSky's "states" format.
// - Airline, route and aircraft type: adsbdb.com (free, called straight from the browser).
// - Photos: planespotters.net (free, must show the photographer's name and link).
// - Airline logos: images.kiwi.com. Place search: OpenStreetMap Nominatim.
// - Map: Leaflet with Esri's dark grey map tiles.

// ---------- Settings ----------

const API_URL = "/api/states"; // takes ?lamin=&lomin=&lamax=&lomax= like OpenSky
const AUTO_REFRESH_MS = 15000;
const EARTH_RADIUS_KM = 6371;
const LAST_GOOD_MAX_AGE_MS = 5 * 60 * 1000; // reuse a saved result up to 5 minutes old…
const LAST_GOOD_MAX_MOVE_KM = 2; // …if you haven't moved further than this
const GPS_TIMEOUT_MS = 10000; // after this, suggest typing a place instead
const SAVED_PLACE_KEY = "planes.savedPlace";
const EMERGENCY_SQUAWKS = { "7500": "Hijack", "7600": "Radio failure", "7700": "Emergency" };

// ---------- State ----------

let pos = null; // where we search: { lat, lon, alt, accuracy, source: "gps" | "manual", label }
let lastGps = null; // the latest GPS fix, even while a typed place is in use
let manualMode = false; // true while the user's typed place overrides GPS
let gpsWatchId = null;
let planes = []; // the aircraft currently shown
let selectedHex = null; // aircraft open in the details view
let lastGood = null; // last successful answer: { states, time, lat, lon, radiusKm }
let firstSearchDone = false;
let loading = false;
let autoTimer = null;
let lastReverseGeocode = null; // { lat, lon } of the last place-name lookup

const $ = (id) => document.getElementById(id);

// ---------- Small helpers ----------

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Great-circle distance in km (haversine formula).
function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// Compass direction (0–360°) from point 1 to point 2.
function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// A box around us that fully contains the circle of radiusKm.
function boundingBox(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(Math.cos(toRad(lat)), 0.01));
  return {
    lamin: Math.max(lat - dLat, -90), lamax: Math.min(lat + dLat, 90),
    lomin: Math.max(lon - dLon, -180), lomax: Math.min(lon + dLon, 180),
  };
}

const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
const feet = (m) => Math.round(m * 3.28084);
const fmt = (n) => Math.round(n).toLocaleString();

// Country code "AE" -> 🇦🇪
const flag = (iso) => iso && /^[A-Z]{2}$/i.test(iso)
  ? String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)))
  : "";

// Colour for an altitude in metres (same steps as the map legend).
function altColor(m) {
  const ft = m == null ? 0 : feet(m);
  const v = ft >= 35000 ? 4 : ft >= 25000 ? 3 : ft >= 15000 ? 2 : ft >= 5000 ? 1 : 0;
  return `var(--alt${v})`;
}

// Build an element: h("div", { class: "x", onclick: fn }, "text", child, …)
// Text always goes in as text, so nothing from an API can inject HTML.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Top-down aeroplane icon, pointing up (north).
const PLANE_PATH = "M12 1.5c.9 0 1.5 1 1.5 2.2v5.6l8 4.8v2.2l-8-2.5v5l2.3 1.8v1.7L12 21.4l-3.8.9v-1.7l2.3-1.8v-5l-8 2.5v-2.2l8-4.8V3.7c0-1.2.6-2.2 1.5-2.2z";
const planeSvg = (deg = 0) =>
  `<svg viewBox="0 0 24 24" style="transform:rotate(${Number(deg) || 0}deg)"><path d="${PLANE_PATH}"/></svg>`;

// ---------- Clock ----------

function tick() {
  const now = new Date();
  $("clockTime").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("clockDate").textContent = now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
tick();
setInterval(tick, 1000);

// ---------- Map ----------

const map = L.map("map", { zoomControl: false, worldCopyJump: true, zoomSnap: 0.25 }).setView([20, 10], 2);
L.control.zoom({ position: "bottomright" }).addTo(map);
// Esri's free dark grey map (no key needed), plus its layer of place names on top.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
L.tileLayer(ESRI + "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
  attribution: "Map &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
  maxZoom: 16,
}).addTo(map);
L.tileLayer(ESRI + "World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "overlayPane" }).addTo(map);

let meMarker = null;
let rangeCircle = null;
const planeMarkers = new Map(); // hex -> Leaflet marker

function radiusKm() {
  return Number(document.querySelector('input[name="radius"]:checked').value);
}

// Put "you" and the search circle on the map, and zoom to fit the circle.
function drawMe(fit) {
  const ll = [pos.lat, pos.lon];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18] }), zIndexOffset: 1000, keyboard: false }).addTo(map);
    rangeCircle = L.circle(ll, { radius: radiusKm() * 1000, color: "#7cf0d4", weight: 1.5, opacity: 0.6, fillColor: "#7cf0d4", fillOpacity: 0.04, dashArray: "6 6" }).addTo(map);
  }
  meMarker.setLatLng(ll);
  rangeCircle.setLatLng(ll).setRadius(radiusKm() * 1000);
  if (fit) map.fitBounds(rangeCircle.getBounds(), { padding: [24, 24] });
}

function planeIcon(p) {
  const classes = ["plane"];
  if (p.hex === selectedHex) classes.push("selected");
  if (p.emergency) classes.push("emergency");
  return L.divIcon({
    className: "",
    html: `<div class="${classes.join(" ")}" style="--c:${altColor(p.altitude)}">${planeSvg(p.heading)}<span class="tag">${escapeHtml(p.callsign)}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// Add, move or remove aircraft markers to match `planes`.
function drawPlanes() {
  const seen = new Set();
  for (const p of planes) {
    seen.add(p.hex);
    let m = planeMarkers.get(p.hex);
    if (!m) {
      m = L.marker([p.lat, p.lon], { icon: planeIcon(p), riseOnHover: true }).addTo(map);
      m.on("click", () => openDetail(p.hex));
      planeMarkers.set(p.hex, m);
    } else {
      m.setLatLng([p.lat, p.lon]).setIcon(planeIcon(p));
    }
    m.setZIndexOffset(p.hex === selectedHex ? 900 : 0);
  }
  for (const [hex, m] of planeMarkers) {
    if (!seen.has(hex)) { m.remove(); planeMarkers.delete(hex); }
  }
}

// ---------- Location ----------

function startGps() {
  if (!("geolocation" in navigator)) {
    setStatus("This browser can't share its location. Search for a place above instead.", true);
    return;
  }
  if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = navigator.geolocation.watchPosition(onGps, onGpsError, {
    enableHighAccuracy: true, maximumAge: 30000, timeout: 20000,
  });

  // If GPS stays silent, offer the typed place instead (and use the last saved one).
  setTimeout(() => {
    if (lastGps || manualMode) return;
    const saved = loadSavedPlace();
    if (saved && !pos) {
      setPosition({ ...saved, source: "manual" });
      manualMode = true;
      setStatus(`GPS isn't responding, so we're using your last place${saved.label ? ": " + saved.label : ""}. Tap GPS to try again.`, true);
    } else if (!pos) {
      setStatus("GPS isn't responding. Type a place or coordinates (e.g. 6.93, 79.85) in the search box.", true);
      $("overlayText").textContent = "GPS isn't responding. Search for a place or type coordinates above.";
    }
  }, GPS_TIMEOUT_MS);
}

function onGps(p) {
  const c = p.coords;
  lastGps = { lat: c.latitude, lon: c.longitude, alt: c.altitude, accuracy: c.accuracy, source: "gps" };
  $("gpsBtn").classList.add("active");
  if (!manualMode) setPosition(lastGps);
}

function onGpsError(err) {
  if (manualMode || lastGps) return;
  if (err.code === err.PERMISSION_DENIED) {
    setStatus("Location permission is blocked. Search for a place above, or allow location in your browser settings.", true);
    $("overlayText").textContent = "Location is blocked. Search for a place or type coordinates above.";
  } else {
    setStatus("Still waiting for GPS… You can also type a place above.", true);
  }
}

// Use a new position: update the panel and map, and reload planes if we moved.
function setPosition(p) {
  const moved = !pos ? Infinity : distanceKm(pos.lat, pos.lon, p.lat, p.lon);
  pos = { ...p };

  $("lat").textContent = pos.lat.toFixed(4) + "°";
  $("lon").textContent = pos.lon.toFixed(4) + "°";
  $("alt").textContent = pos.alt == null ? "n/a" : Math.round(pos.alt) + " m";
  $("source").textContent = pos.source === "gps" ? "📡 GPS" : "📍 Typed";
  setStatus(pos.source === "gps"
    ? `Using your GPS (accuracy ±${Math.round(pos.accuracy)} m).`
    : `Using ${pos.label || "the place you typed"}. Tap GPS to switch back.`);

  $("showBtn").disabled = false;
  $("refreshBtn").disabled = false;
  if (!firstSearchDone) $("overlayText").textContent = "Found you. Ready when you are.";

  if (pos.label) $("placeName").textContent = pos.label;
  else lookUpPlaceName();

  // Ignore tiny GPS wobbles; react to real moves.
  if (moved > 0.5) {
    drawMe(true);
    if (firstSearchDone) loadPlanes();
  }
}

function setStatus(text, warn = false) {
  $("locStatus").textContent = text;
  $("locStatus").classList.toggle("warn", warn);
}

// "lat, lon" typed by hand? Returns { lat, lon } or null.
function parseCoordinates(text) {
  const m = text.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// Search box: coordinates or a place name.
$("locForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("locInput").value.trim();
  if (!text) return;

  const coords = parseCoordinates(text);
  if (coords) {
    usePlace({ ...coords, label: null }); // the town name gets looked up
    return;
  }

  setStatus(`Searching for "${text}"…`);
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(text);
    const [hit] = await (await fetch(url)).json();
    if (!hit) { setStatus(`Couldn't find "${text}". Try a city name, or coordinates like 6.93, 79.85.`, true); return; }
    usePlace({ lat: Number(hit.lat), lon: Number(hit.lon), label: shortPlace(hit.display_name) });
  } catch {
    setStatus("Place search isn't reachable right now. Try typing coordinates like 6.93, 79.85.", true);
  }
});

function usePlace(place) {
  manualMode = true;
  savePlace(place);
  $("locInput").value = "";
  $("locInput").blur();
  setPosition({ ...place, alt: null, accuracy: null, source: "manual" });
  if (!firstSearchDone) loadPlanes();
}

$("gpsBtn").addEventListener("click", () => {
  manualMode = false;
  try { localStorage.removeItem(SAVED_PLACE_KEY); } catch {}
  if (lastGps) setPosition(lastGps);
  else { setStatus("Waiting for GPS…"); startGps(); }
});

// "Colombo, Colombo District, Western Province, Sri Lanka" -> "Colombo, Sri Lanka"
function shortPlace(name) {
  const parts = String(name).split(",").map((s) => s.trim());
  return parts.length > 2 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts.join(", ");
}

// Show a town name for GPS positions (once per km moved).
async function lookUpPlaceName() {
  if (lastReverseGeocode && distanceKm(lastReverseGeocode.lat, lastReverseGeocode.lon, pos.lat, pos.lon) < 1) return;
  lastReverseGeocode = { lat: pos.lat, lon: pos.lon };
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=${pos.lat}&lon=${pos.lon}`;
    const r = await (await fetch(url)).json();
    const a = r.address || {};
    const town = a.city || a.town || a.village || a.suburb || a.county || a.state;
    $("placeName").textContent = [town, a.country].filter(Boolean).join(", ") || "Your location";
  } catch {
    $("placeName").textContent = "Your location";
  }
}

function savePlace(p) {
  try { localStorage.setItem(SAVED_PLACE_KEY, JSON.stringify(p)); } catch {}
}
function loadSavedPlace() {
  try { return JSON.parse(localStorage.getItem(SAVED_PLACE_KEY)); } catch { return null; }
}

// ---------- Loading aircraft ----------

async function loadPlanes() {
  if (!pos || loading) return;
  loading = true;
  const r = radiusKm();
  const url = API_URL + "?" + new URLSearchParams(boundingBox(pos.lat, pos.lon, r));

  firstSearchDone = true;
  $("mapOverlay").hidden = true;
  hideMessage();
  $("refreshBtn").classList.add("spin");
  if (!planes.length) $("summary").textContent = "Scanning the sky…";

  try {
    if (!navigator.onLine) throw new Error("offline");

    // 429 = rate limit. The Worker already retried once; if still busy,
    // wait 3 seconds and ask one more time.
    const isBusy = (res) => res.status === 429 || res.status === 403;
    let res = await fetch(url);
    if (isBusy(res)) {
      $("summary").textContent = "Data service busy, trying again…";
      await new Promise((ok) => setTimeout(ok, 3000));
      res = await fetch(url);
    }
    if (isBusy(res)) {
      // Still busy: show the last good result for this spot instead, if we have one.
      if (canReuseLastGood(r)) show(lastGood.states, r, lastGood.time);
      else showMessage("The free flight data service is busy right now. It usually recovers within a minute — tap refresh to try again.");
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);

    const data = await res.json();
    lastGood = { states: data.states || [], time: Date.now(), lat: pos.lat, lon: pos.lon, radiusKm: r };
    show(lastGood.states, r);
  } catch (err) {
    const offline = !navigator.onLine || err.message === "offline";
    showMessage(offline
      ? "No internet connection. Check your connection and try again."
      : `Couldn't load aircraft right now (${err.message}). Please try again.`);
  } finally {
    loading = false;
    $("refreshBtn").classList.remove("spin");
  }
}

// The last good result is usable if it's recent, for (about) the same spot,
// and was fetched for at least this radius (a smaller one would miss planes).
function canReuseLastGood(r) {
  return lastGood != null &&
    Date.now() - lastGood.time < LAST_GOOD_MAX_AGE_MS &&
    lastGood.radiusKm >= r &&
    distanceKm(lastGood.lat, lastGood.lon, pos.lat, pos.lon) < LAST_GOOD_MAX_MOVE_KM;
}

// Turn OpenSky-style arrays into plane objects. Positions used:
// 0 hex, 1 callsign, 2 country, 5 lon, 6 lat, 7 baro alt (m), 8 on ground, 9 speed (m/s),
// 10 heading, 11 vertical rate (m/s), 13 GPS alt (m), 14 squawk, 17 registration, 18 type code
function toPlane(s) {
  const lat = s[6], lon = s[5];
  const squawk = s[14] ? String(s[14]) : null;
  return {
    hex: s[0],
    callsign: (s[1] || "").trim() || (s[17] || s[0] || "?").toUpperCase(),
    hasCallsign: Boolean((s[1] || "").trim()),
    country: s[2],
    lat, lon,
    // Prefer pressure altitude; use GPS altitude if it's missing or below zero.
    altitude: s[7] != null && s[7] >= 0 ? s[7] : s[13] ?? s[7],
    speed: s[9],
    heading: s[10],
    vertical: s[11],
    squawk,
    emergency: EMERGENCY_SQUAWKS[squawk] || null,
    registration: s[17] || null,
    typeCode: s[18] || null,
    distance: distanceKm(pos.lat, pos.lon, lat, lon),
    bearing: bearingDeg(pos.lat, pos.lon, lat, lon),
  };
}

// fetchedAt is only set when showing an older saved result.
function show(states, r, fetchedAt = null) {
  planes = states
    .filter((s) => s[5] != null && s[6] != null && !s[8]) // has a position, not on the ground
    .map(toPlane)
    .filter((p) => p.distance <= r)
    .sort((a, b) => a.distance - b.distance);

  const when = fetchedAt
    ? `data from ${Math.round((Date.now() - fetchedAt) / 1000)} s ago, service busy`
    : "updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("summary").textContent = planes.length
    ? `${planes.length} aircraft within ${r} km · closest first · ${when}`
    : `Checked within ${r} km · ${when}`;

  drawStats();
  drawList(r);
  drawPlanes();
  if (selectedHex) refreshDetailLive();
}

function drawStats() {
  const set = (id, value, sub) => {
    $(id).replaceChildren(value, ...(sub ? [h("span", { class: "sub" }, sub)] : []));
  };
  if (!planes.length) {
    ["statClosest", "statHighest", "statFastest"].forEach((id) => set(id, "–"));
    set("statCount", "0");
    return;
  }
  const closest = planes[0];
  const highest = planes.reduce((a, b) => ((b.altitude ?? -1) > (a.altitude ?? -1) ? b : a));
  const fastest = planes.reduce((a, b) => ((b.speed ?? -1) > (a.speed ?? -1) ? b : a));
  set("statCount", String(planes.length));
  set("statClosest", closest.distance.toFixed(1) + " km", closest.callsign);
  // Compact numbers so they fit the small boxes: "41.0k ft", "1,133 km/h"
  set("statHighest", highest.altitude == null ? "–" : (feet(highest.altitude) / 1000).toFixed(1) + "k ft", highest.callsign);
  set("statFastest", fastest.speed == null ? "–" : fmt(fastest.speed * 3.6) + " km/h", fastest.callsign);
}

function verticalText(rate) {
  if (rate == null) return { text: "–", cls: "" };
  if (rate > 1) return { text: "▲ Climbing", cls: "climbing" };
  if (rate < -1) return { text: "▼ Descending", cls: "descending" };
  return { text: "▬ Level", cls: "" };
}

function drawList(r) {
  const list = $("list");
  if (!planes.length) {
    list.replaceChildren(h("li", { class: "empty" },
      h("div", { style: "font-size:2rem" }, "🌤️"),
      h("b", {}, `No aircraft within ${r} km right now`),
      "Try a bigger radius, or check back in a minute."));
    return;
  }
  list.replaceChildren(...planes.map((p) => {
    const ico = h("span", { class: "ico", style: `--c:${altColor(p.altitude)}` });
    ico.innerHTML = planeSvg(p.heading);
    const v = verticalText(p.vertical);
    const sub = h("div", { class: "sub", "data-sub": p.hex }, airlineLine(p));
    const row = h("button", { class: "row" + (p.hex === selectedHex ? " selected" : ""), "data-hex": p.hex, onclick: () => openDetail(p.hex) },
      ico,
      h("div", { class: "main" },
        h("div", { class: "cs" }, p.callsign, p.typeCode && h("small", {}, p.typeCode),
          p.emergency && h("span", { class: "badge" }, p.emergency)),
        sub),
      h("div", { class: "side" },
        h("div", { class: "dist" }, p.distance.toFixed(1) + " km"),
        h("div", { class: "altv" },
          p.altitude == null ? "–" : fmt(feet(p.altitude)) + " ft ",
          h("span", { class: v.cls }, v.cls ? v.text[0] : ""))));
    fillAirlineLine(p, sub);
    return h("li", {}, row);
  }));
}

// First guess at the line under the callsign, before the airline lookup returns.
function airlineLine(p) {
  return `${compass(p.bearing)} of you · ${p.country || "Unknown country"}`;
}

// Replace it with "Emirates · DXB → LHR" once we know.
async function fillAirlineLine(p, el) {
  const info = await flightInfo(p);
  if (!el.isConnected) return;
  const parts = [];
  if (info.airline) parts.push(info.airline.name);
  else if (info.privateFlight) parts.push("Private / general aviation");
  if (info.route) parts.push(`${info.route.origin.iata_code || info.route.origin.icao_code} → ${info.route.destination.iata_code || info.route.destination.icao_code}`);
  if (parts.length) el.textContent = parts.join(" · ");
}

// ---------- Airline, route, aircraft and photo lookups (cached) ----------

const cache = new Map();
function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch(() => null));
  return cache.get(key);
}

// adsbdb allows browser requests; keep it gentle with 3 at a time.
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

const getRoute = (callsign) => cached("route:" + callsign, async () =>
  (await getJson("https://api.adsbdb.com/v0/callsign/" + encodeURIComponent(callsign)))?.response?.flightroute || null);

const getAirline = (icao) => cached("airline:" + icao, async () => {
  const list = (await getJson("https://api.adsbdb.com/v0/airline/" + icao))?.response;
  return Array.isArray(list) ? list[0] : null;
});

const getAircraft = (hex) => cached("aircraft:" + hex, async () =>
  (await getJson("https://api.adsbdb.com/v0/aircraft/" + hex))?.response?.aircraft || null);

const getPhoto = (hex) => cached("photo:" + hex, async () => {
  const r = await fetch("https://api.planespotters.net/pub/photos/hex/" + hex);
  return r.ok ? (await r.json()).photos?.[0] || null : null;
});

// Airline + route for a flight. Airline flights use callsigns like "UAE5"
// (3-letter airline code + number); private flights usually use the registration.
function flightInfo(p) {
  return cached("info:" + p.hex + p.callsign, async () => {
    if (!p.hasCallsign) return {};
    const isAirline = /^[A-Z]{3}\d/.test(p.callsign);
    const route = isAirline ? await getRoute(p.callsign) : null;
    const airline = route?.airline || (isAirline ? await getAirline(p.callsign.slice(0, 3)) : null);
    const privateFlight = !isAirline && p.registration &&
      p.callsign.replace(/-/g, "") === p.registration.replace(/-/g, "").toUpperCase();
    return { route, airline, privateFlight };
  });
}

// ---------- Details view ----------

const findPlane = (hex) => planes.find((p) => p.hex === hex);

function openDetail(hex) {
  selectedHex = hex;
  const p = findPlane(hex);
  if (!p) return;
  $("detail").hidden = false;
  document.querySelectorAll(".row").forEach((r) => r.classList.toggle("selected", r.dataset.hex === hex));
  drawPlanes();
  map.panInside([p.lat, p.lon], { padding: [60, 60] });
  renderDetail(p);
}

function closeDetail() {
  selectedHex = null;
  $("detail").hidden = true;
  drawPlanes();
  drawList(radiusKm());
}

$("detail").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDetail(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selectedHex) closeDetail(); });

// Build the details card. Slow lookups (photo, airline, route, aircraft) fill in as they arrive.
function renderDetail(p) {
  const card = $("detailCard");
  const photo = h("div", { class: "photo" }, placeholderPhoto("Looking for a photo…"));
  const title = h("h2", {}, p.callsign);
  const subtitle = h("p", {}, p.country ? `${flag(isoFromCountry(p.country))} Registered in ${p.country}` : "");
  const routeBox = h("div", { class: "route" }, h("div", { class: "note" }, "Looking up the route…"));
  const aircraftGrid = h("div", { class: "grid" },
    cell("Type", p.typeCode || "–", "d-type"),
    cell("Registration", p.registration || "–", "d-reg"),
    cell("Operator", "–", "d-owner"),
    cell("ICAO address", p.hex.toUpperCase()));

  card.replaceChildren(
    h("button", { class: "close", "data-close": "", "aria-label": "Close" }, "×"),
    photo,
    h("div", { class: "d-body" },
      h("div", { class: "d-head" }, title, subtitle),
      h("div", { id: "d-alert" }),
      routeBox,
      h("div", { class: "d-section" }, "Live"),
      h("div", { class: "grid", id: "d-live" }),
      h("div", { class: "d-section" }, "Aircraft"),
      aircraftGrid,
      h("div", { class: "links" },
        h("a", { class: "btn", href: "https://www.flightradar24.com/" + encodeURIComponent(p.callsign), target: "_blank", rel: "noopener" }, "Flightradar24 ↗"),
        h("a", { class: "btn", href: "https://adsb.lol/?icao=" + encodeURIComponent(p.hex), target: "_blank", rel: "noopener" }, "Live track ↗"))));
  card.scrollTop = 0;
  refreshDetailLive();

  // Photo (planespotters first, then adsbdb's)
  Promise.all([getPhoto(p.hex), getAircraft(p.hex)]).then(([ps, ac]) => {
    if (selectedHex !== p.hex) return;
    if (ps) {
      photo.replaceChildren(
        h("img", { src: ps.thumbnail_large?.src || ps.thumbnail?.src, alt: `Photo of ${p.registration || p.callsign}` }),
        h("span", { class: "credit" }, "📷 ", h("a", { href: ps.link, target: "_blank", rel: "noopener" }, `${ps.photographer} / planespotters.net`)));
    } else if (ac?.url_photo) {
      photo.replaceChildren(
        h("img", { src: ac.url_photo, alt: `Photo of ${ac.registration}` }),
        h("span", { class: "credit" }, "📷 airport-data.com"));
    } else {
      photo.replaceChildren(placeholderPhoto("No photo of this aircraft yet"));
    }

    // Aircraft details
    if (ac) {
      setCell("d-type", [ac.manufacturer, ac.type].filter(Boolean).join(" ") || p.typeCode || "–");
      setCell("d-reg", ac.registration || p.registration || "–");
      setCell("d-owner", ac.registered_owner || "–");
      if (ac.registered_owner_country_iso_name) {
        subtitle.textContent = `${flag(ac.registered_owner_country_iso_name)} Registered in ${ac.registered_owner_country_name}`;
      }
    }
  });

  // Airline and route
  flightInfo(p).then((info) => {
    if (selectedHex !== p.hex) return;
    if (info.airline) {
      const iata = info.airline.iata;
      const flightNo = iata && info.route?.callsign_iata ? info.route.callsign_iata : null;
      title.replaceChildren(p.callsign, flightNo ? h("small", {}, flightNo) : "");
      const logo = iata ? h("img", { src: `https://images.kiwi.com/airlines/64/${iata}.png`, alt: "", style: "width:28px;height:28px;border-radius:6px;vertical-align:-8px;margin-right:8px;background:#fff", onerror: (e) => e.target.remove() }) : null;
      subtitle.replaceChildren(logo || "", `${info.airline.name} ${flag(info.airline.country_iso)}`.trim());
    } else if (info.privateFlight) {
      subtitle.textContent = "Private / general aviation";
    }
    drawRoute(routeBox, info.route, p);
  });
}

function drawRoute(box, route, p) {
  if (!route) {
    box.replaceChildren(h("div", { class: "note" }, p.hasCallsign
      ? "Route not known for this flight (common for private, cargo and military flights)."
      : "This aircraft isn't sending a flight number."));
    return;
  }
  const o = route.origin, d = route.destination;
  const ap = (a) => h("div", { class: "ap" },
    h("div", { class: "code" }, a.iata_code || a.icao_code),
    h("div", { class: "city" }, `${flag(a.country_iso_name)} ${a.municipality || a.name}`),
    h("div", { class: "city", title: a.name }, a.name));

  // How far along the trip, by distance flown so far.
  const done = distanceKm(o.latitude, o.longitude, p.lat, p.lon);
  const left = distanceKm(p.lat, p.lon, d.latitude, d.longitude);
  const pct = Math.min(100, Math.max(0, (done / (done + left)) * 100));

  box.replaceChildren(ap(o), h("div", { class: "mid" }, "✈"), ap(d),
    h("div", { class: "progress" },
      h("div", { style: `width:${pct}%` }),
      h("span", { style: `left:${pct}%` }, "✈")),
    h("div", { class: "note" }, `${fmt(done)} km flown · ${fmt(left)} km to go`));
}

// Live numbers, refreshed every time the planes update.
function refreshDetailLive() {
  const live = $("d-live");
  if (!live) return;
  const p = findPlane(selectedHex);
  if (!p) {
    live.replaceChildren(h("div", { class: "stale", style: "grid-column:1/-1" }, "This aircraft has left your search area."));
    return;
  }
  const v = verticalText(p.vertical);
  const rate = p.vertical == null || Math.abs(p.vertical) <= 1 ? "" : ` ${fmt(Math.abs(p.vertical) * 196.85)} ft/min`;
  live.replaceChildren(
    cell("Altitude", p.altitude == null ? "–" : `${fmt(feet(p.altitude))} ft · ${fmt(p.altitude)} m`),
    cell("Speed", p.speed == null ? "–" : `${fmt(p.speed * 3.6)} km/h · ${fmt(p.speed * 1.94384)} kt`),
    cell("Heading", p.heading == null ? "–" : `${Math.round(p.heading)}° ${compass(p.heading)}`),
    cell("Vertical", h("span", { class: v.cls }, v.text + rate)),
    cell("From you", `${p.distance.toFixed(1)} km ${compass(p.bearing)}`),
    cell("Squawk", p.squawk || "–"));
  $("d-alert").replaceChildren(p.emergency
    ? h("div", { class: "alert" }, `⚠️ Squawking ${p.squawk}: ${p.emergency}`)
    : "");
}

function cell(label, value, id) {
  return h("div", {}, h("span", { class: "k" }, label), h("span", { class: "v", id }, value));
}
function setCell(id, value) { const el = $(id); if (el) el.textContent = value; }

function placeholderPhoto(text) {
  const ph = h("div", { class: "ph" });
  ph.innerHTML = `<div><svg viewBox="0 0 24 24"><path d="${PLANE_PATH}"/></svg></div>`;
  ph.firstChild.append(text);
  return ph;
}

// Our position data names countries in English; map the common ones to flags.
const COUNTRY_ISO = {
  "United States": "US", "United Kingdom": "GB", "Germany": "DE", "France": "FR", "Italy": "IT",
  "Spain": "ES", "Netherlands": "NL", "Ireland": "IE", "United Arab Emirates": "AE", "Qatar": "QA",
  "Saudi Arabia": "SA", "India": "IN", "Sri Lanka": "LK", "China": "CN", "Japan": "JP",
  "Singapore": "SG", "Australia": "AU", "Canada": "CA", "Turkey": "TR", "Switzerland": "CH",
  "Austria": "AT", "Belgium": "BE", "Portugal": "PT", "Poland": "PL", "Norway": "NO",
  "Sweden": "SE", "Denmark": "DK", "Finland": "FI", "Brazil": "BR", "Mexico": "MX",
};
const isoFromCountry = (name) => COUNTRY_ISO[name] || "";

// ---------- Messages ----------

function showMessage(text) { $("message").textContent = text; $("message").hidden = false; }
function hideMessage() { $("message").hidden = true; }

// ---------- Buttons ----------

$("showBtn").addEventListener("click", loadPlanes);
$("refreshBtn").addEventListener("click", loadPlanes);

document.querySelectorAll('input[name="radius"]').forEach((el) =>
  el.addEventListener("change", () => {
    if (!pos) return;
    drawMe(true);
    if (firstSearchDone) loadPlanes();
  }));

function setAuto() {
  clearInterval(autoTimer);
  if ($("autoRefresh").checked) autoTimer = setInterval(() => { if (firstSearchDone) loadPlanes(); }, AUTO_REFRESH_MS);
}
$("autoRefresh").addEventListener("change", setAuto);
setAuto();

window.addEventListener("offline", () => showMessage("You're offline. Results will update again when you reconnect."));
window.addEventListener("online", hideMessage);

startGps();
