// Planes Above Me – shows live aircraft near your current location.
// Data comes from this site's own Cloudflare Worker (see src/worker.js). It
// speaks the OpenSky API format, but fetches from adsb.lol, because
// OpenSky blocks direct browser requests and requests from Cloudflare.

// Takes ?lamin=&lomin=&lamax=&lomax= like OpenSky.
const API_URL = "/api/states";

const AUTO_REFRESH_MS = 15000;
const EARTH_RADIUS_KM = 6371;

// Remember where we are and the auto-refresh timer.
let myPosition = null; // { lat, lon, alt }
let autoTimer = null;

// The last successful answer, shown again (marked as old) if the data
// service is busy: { states, time, lat, lon, radiusKm }
let lastGood = null;
const LAST_GOOD_MAX_AGE_MS = 5 * 60 * 1000; // older than 5 minutes is too stale
const LAST_GOOD_MAX_MOVE_KM = 2; // ignore it if you've moved further than this

// Shortcut for getting page elements.
const $ = (id) => document.getElementById(id);

// ---------- Clock ----------

function updateClock() {
  $("clock").textContent = new Date().toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
updateClock();
setInterval(updateClock, 1000);

// ---------- Location ----------

function askForLocation() {
  if (!("geolocation" in navigator)) {
    $("locStatus").textContent = "This browser cannot share its location.";
    return;
  }
  // watchPosition keeps the position fresh if you move around.
  navigator.geolocation.watchPosition(onLocation, onLocationError, {
    enableHighAccuracy: true,
    maximumAge: 30000,
    timeout: 20000,
  });
}

function onLocation(pos) {
  const c = pos.coords;
  myPosition = { lat: c.latitude, lon: c.longitude, alt: c.altitude };

  $("lat").textContent = c.latitude.toFixed(5) + "°";
  $("lon").textContent = c.longitude.toFixed(5) + "°";
  $("alt").textContent = c.altitude == null
    ? "not provided"
    : Math.round(c.altitude) + " m";
  $("locStatus").textContent = "Location found (accuracy ±" + Math.round(c.accuracy) + " m).";

  $("showBtn").disabled = false;
  $("refreshBtn").disabled = false;
}

function onLocationError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    $("locStatus").textContent = "Location permission denied.";
    showMessage("Location is blocked. Allow location for this site in your browser settings, then reload the page.");
  } else {
    $("locStatus").textContent = "Could not get your location yet. Still trying…";
  }
}

// ---------- Maths helpers ----------

const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle distance in km between two points (haversine formula).
function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// A square box around us that fully contains the circle of radiusKm.
function boundingBox(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32; // km per degree of latitude
  // Degrees of longitude shrink towards the poles; avoid dividing by ~0.
  const dLon = radiusKm / (111.32 * Math.max(Math.cos(toRad(lat)), 0.01));
  return {
    lamin: Math.max(lat - dLat, -90),
    lamax: Math.min(lat + dLat, 90),
    lomin: Math.max(lon - dLon, -180),
    lomax: Math.min(lon + dLon, 180),
  };
}

// 0–360° heading to a compass word, e.g. 47 -> "NE".
function compass(deg) {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(deg / 45) % 8];
}

// ---------- Fetching aircraft ----------

async function loadPlanes() {
  if (!myPosition) return;

  const radiusKm = Number($("radius").value);
  const box = boundingBox(myPosition.lat, myPosition.lon, radiusKm);
  const url = API_URL + "?" + new URLSearchParams(box);

  hideMessage();
  $("summary").textContent = "Looking for planes…";
  $("showBtn").disabled = true;

  try {
    if (!navigator.onLine) throw new Error("offline");

    // 429 = rate limit. The Worker already retried once; if still busy,
    // wait 3 seconds and ask one more time.
    const isBusy = (r) => r.status === 429 || r.status === 403;
    let response = await fetch(url);
    if (isBusy(response)) {
      $("summary").textContent = "Data service busy, trying again…";
      await new Promise((r) => setTimeout(r, 3000));
      response = await fetch(url);
    }
    if (isBusy(response)) {
      // Still busy: show the last good result for this spot instead, if we have one.
      if (canReuseLastGood(radiusKm)) {
        showPlanes(lastGood.states, radiusKm, lastGood.time);
      } else {
        showMessage("The free flight data service is busy (rate limit). Wait a few seconds and try again.");
        $("summary").textContent = "";
      }
      return;
    }
    if (!response.ok) throw new Error("HTTP " + response.status);

    const data = await response.json();
    lastGood = { states: data.states || [], time: Date.now(), lat: myPosition.lat, lon: myPosition.lon, radiusKm };
    showPlanes(lastGood.states, radiusKm);
  } catch (err) {
    const offline = !navigator.onLine || err.message === "offline";
    showMessage(offline
      ? "No internet connection. Check your connection and try again."
      : "Could not load aircraft right now (" + err.message + "). Please try again.");
    $("summary").textContent = "";
  } finally {
    $("showBtn").disabled = false;
  }
}

// The last good result is usable if it's recent, for (about) the same spot,
// and was fetched for at least this radius (a smaller one would miss planes).
function canReuseLastGood(radiusKm) {
  return lastGood != null &&
    Date.now() - lastGood.time < LAST_GOOD_MAX_AGE_MS &&
    lastGood.radiusKm >= radiusKm &&
    distanceKm(lastGood.lat, lastGood.lon, myPosition.lat, myPosition.lon) < LAST_GOOD_MAX_MOVE_KM;
}

// The Worker returns each aircraft as an OpenSky-style array. The positions we use:
// 1 callsign, 2 origin country, 5 longitude, 6 latitude, 7 barometric altitude (m),
// 8 on ground, 9 speed (m/s), 10 heading (°), 11 vertical rate (m/s), 13 GPS altitude (m)
// fetchedAt is set only when showing an older saved result.
function showPlanes(states, radiusKm, fetchedAt = null) {
  const planes = states
    .filter((s) => s[5] != null && s[6] != null && !s[8]) // has a position, not on the ground
    .map((s) => ({
      callsign: (s[1] || "").trim() || "Unknown",
      country: s[2],
      // Prefer barometric altitude; use GPS when it's missing or below zero
      // (pressure altitude can read negative for planes about to land).
      altitude: s[7] != null && s[7] >= 0 ? s[7] : s[13] ?? s[7],
      speed: s[9],
      heading: s[10],
      vertical: s[11],
      distance: distanceKm(myPosition.lat, myPosition.lon, s[6], s[5]),
    }))
    .filter((p) => p.distance <= radiusKm)
    .sort((a, b) => a.distance - b.distance);

  // Normally "updated 20:17:05"; for a saved result "data from 40 s ago".
  const when = fetchedAt
    ? "data from " + Math.round((Date.now() - fetchedAt) / 1000) + " s ago, service busy"
    : "updated " + new Date().toLocaleTimeString();
  const results = $("results");
  results.innerHTML = "";

  if (planes.length === 0) {
    $("summary").textContent = "No aircraft within " + radiusKm + " km right now. (" + when + ")";
    return;
  }

  $("summary").textContent = planes.length + " aircraft" +
    " within " + radiusKm + " km, closest first. (" + when + ")";
  planes.forEach((p) => results.appendChild(planeCard(p)));
}

// Build one card. Values go in with textContent so nothing from the API is run as HTML.
function planeCard(p) {
  const card = document.createElement("article");
  card.className = "card";

  const head = document.createElement("div");
  head.className = "card-head";
  head.append(
    el("span", "callsign", p.callsign),
    el("span", "distance", p.distance.toFixed(1) + " km away"),
  );
  card.append(head);

  const alt = p.altitude == null
    ? "unknown"
    : Math.round(p.altitude).toLocaleString() + " m / " +
      Math.round(p.altitude * 3.28084).toLocaleString() + " ft";
  const speed = p.speed == null ? "unknown" : Math.round(p.speed * 3.6) + " km/h";

  card.append(
    row("Altitude", alt),
    row("Speed", speed),
    headingRow(p.heading),
    verticalRow(p.vertical),
    row("Country", p.country || "unknown"),
  );
  return card;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function row(label, value, valueClass = "") {
  const div = el("div", "row", "");
  div.append(el("span", "label", label), el("span", valueClass, value));
  return div;
}

// Heading with a small arrow rotated to point the way the plane flies.
function headingRow(deg) {
  if (deg == null) return row("Heading", "unknown");
  const r = row("Heading", " " + Math.round(deg) + "° " + compass(deg));
  const arrow = el("span", "arrow", "↑");
  arrow.style.transform = "rotate(" + deg + "deg)";
  r.lastChild.prepend(arrow);
  return r;
}

// Climbing / descending / level, using ±1 m/s so small wobbles count as level.
function verticalRow(rate) {
  if (rate == null) return row("Vertical", "unknown");
  if (rate > 1) return row("Vertical", "▲ climbing (" + Math.round(rate * 196.85) + " ft/min)", "climbing");
  if (rate < -1) return row("Vertical", "▼ descending (" + Math.round(-rate * 196.85) + " ft/min)", "descending");
  return row("Vertical", "▬ level");
}

// ---------- Messages ----------

function showMessage(text) {
  $("message").textContent = text;
  $("message").hidden = false;
}

function hideMessage() {
  $("message").hidden = true;
}

// ---------- Buttons ----------

$("showBtn").addEventListener("click", loadPlanes);
$("refreshBtn").addEventListener("click", loadPlanes);

// Changing the radius reloads only if we already showed results.
$("radius").addEventListener("change", () => {
  if ($("summary").textContent) loadPlanes();
});

$("autoRefresh").addEventListener("change", (e) => {
  clearInterval(autoTimer);
  if (e.target.checked) {
    loadPlanes();
    autoTimer = setInterval(loadPlanes, AUTO_REFRESH_MS);
  }
});

window.addEventListener("offline", () => showMessage("You are offline. Results will not update until you reconnect."));
window.addEventListener("online", hideMessage);

askForLocation();
