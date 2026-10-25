// Planes Above Me – the page. Wires the map, list, details, tabs and settings together.
// See README.md for where each piece of data comes from.

import { distanceKm, bearingDeg, compass, parseCoordinates, nearestAirport, elevationDeg } from "./geo.js";
import { makeFormat } from "./format.js";
import { t, setLanguage, guessLanguage, LANGUAGES, lang, translatePage } from "./i18n.js";
import { settings, saveSettings, applyLook, watchItems } from "./settings.js";
import * as api from "./api.js";
import { createMap, planeSvg, altColor, PLANE_PATH } from "./mapview.js";
import { badges, RARE_TYPES, EMERGENCY_SQUAWKS, loadLog, addToLog, ping, notify, askNotifications, matchesWatch } from "./spotter.js";
import { renderSkyView, createAR } from "./sky.js";
import { shareUrl, readShareParams, shareLink, shareCard } from "./share.js";

// ---------- Settings that rarely change ----------

const LAST_GOOD_MAX_AGE_MS = 5 * 60 * 1000; // reuse a saved result up to 5 minutes old…
const LAST_GOOD_MAX_MOVE_KM = 2; // …if you haven't moved further than this
const GPS_TIMEOUT_MS = 10000; // after this, suggest typing a place instead
const OVERHEAD_KM = 3, OVERHEAD_ALT_M = 4000; // "right above you"
const SAVED_PLACE_KEY = "planes.savedPlace";

// ---------- State ----------

let pos = null; // where we search: { lat, lon, alt, accuracy, source: "gps" | "manual", label }
let lastGps = null; // latest GPS fix, even while a typed place is in use
let manualMode = false;
let gpsWatchId = null;
let planes = []; // all aircraft in range
let worldPlane = null; // a flight found far away with the search box
let selectedHex = null;
let lastGood = null; // last successful answer: { states, time, lat, lon, radiusKm }
let firstSearchDone = false;
let loading = false;
let autoTimer = null;
let filter = "all";
let findText = "";
let log = loadLog();
let fmt = makeFormat();
let tab = "flights";
const seenHexes = new Set(); // planes seen this visit (for "new plane" sounds)
const alerted = new Set(); // planes we already alerted about
const infoByHex = new Map(); // resolved airline/route info, for filtering
let lastAnnounced = -1;
let lastShown = null; // { r, fetchedAt, at } of the latest results, for the summary line

const $ = (id) => document.getElementById(id);

// Build an element: h("div", { class: "x", onclick: fn }, "text", child, …).
// Text always goes in as text, so nothing from an API can inject HTML.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const svg = (html, cls = "") => { const s = h("span", { class: cls }); s.innerHTML = html; return s; };

// Country code "AE" -> 🇦🇪
const flag = (iso) => iso && /^[A-Z]{2}$/i.test(iso)
  ? String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";
const COUNTRY_ISO = {
  "United States": "US", "United Kingdom": "GB", Germany: "DE", France: "FR", Italy: "IT", Spain: "ES",
  Netherlands: "NL", Ireland: "IE", "United Arab Emirates": "AE", Qatar: "QA", "Saudi Arabia": "SA",
  India: "IN", "Sri Lanka": "LK", China: "CN", Japan: "JP", Singapore: "SG", Australia: "AU", Canada: "CA",
  Turkey: "TR", Switzerland: "CH", Austria: "AT", Belgium: "BE", Portugal: "PT", Poland: "PL", Norway: "NO",
  Sweden: "SE", Denmark: "DK", Finland: "FI", Brazil: "BR", Mexico: "MX", Russia: "RU", Thailand: "TH",
  Malaysia: "MY", Indonesia: "ID", "South Korea": "KR", Egypt: "EG", "South Africa": "ZA", Greece: "GR",
  Israel: "IL", Pakistan: "PK", Bangladesh: "BD", Oman: "OM", Kuwait: "KW", Jordan: "JO", "New Zealand": "NZ",
};

// ---------- Start-up ----------

const mapView = createMap($("map"), { onSelect: (hex) => openDetail(hex) });
const ar = createAR($("ar"), {
  getPlanes: () => planes.map((p) => ({ ...p, arLine: [fmt.dist(p.distance), fmt.altShort(p.altitude)].join(" · ") })),
  getObserverAlt: () => pos?.alt || 0,
  t,
});

init();

async function init() {
  applyLook();
  window.addEventListener("error", (e) => api.reportError(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => api.reportError("promise: " + (e.reason?.stack || e.reason)));

  await setLanguage(settings().lang || guessLanguage());
  refreshFormat();
  applyMapStyle();
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", applyMapStyle);
  setRadius(settings().radius);
  fillLanguageSelect();
  renderCityLinks();
  renderLog();
  wireUi();
  tick();
  setInterval(tick, 1000);
  setAuto();
  api.countVisit();
  registerServiceWorker();
  const startTab = new URLSearchParams(location.search).get("tab");
  if (["flights", "airport", "sky", "me"].includes(startTab)) showTab(startTab);

  // A shared link, a city page or a saved place can preset the location.
  const shared = readShareParams();
  const preset = document.querySelector('meta[name="preset"]')?.content?.split(",");
  if (shared) {
    if (shared.radius) setRadius(shared.radius);
    usePlace({ lat: shared.lat, lon: shared.lon, label: null }, { save: false, openHex: shared.hex });
  } else if (preset?.length >= 3) {
    usePlace({ lat: Number(preset[0]), lon: Number(preset[1]), label: preset.slice(2).join(",") }, { save: false });
  }
  startGps();
}

function refreshFormat() {
  fmt = makeFormat({ units: settings().units, clock: settings().clock, locale: lang() === "en" ? undefined : lang() });
  document.querySelectorAll(".seg [data-r]").forEach((el) => { el.textContent = fmt.dist(Number(el.dataset.r), 0); });
}

function tick() {
  const now = new Date();
  $("clockTime").textContent = fmt.time(now);
  $("clockDate").textContent = fmt.date(now);
}

const radiusKm = () => Number(document.querySelector('input[name="radius"]:checked').value);
function setRadius(r) {
  const el = document.querySelector(`input[name="radius"][value="${r}"]`);
  if (el) el.checked = true;
}

// ---------- Location ----------

function startGps() {
  if (!("geolocation" in navigator)) { setStatus(t("gpsBlocked"), true); return; }
  if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = navigator.geolocation.watchPosition(onGps, onGpsError, { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });

  // If GPS stays silent, use the last typed place (or suggest typing one).
  setTimeout(() => {
    if (lastGps || manualMode || pos) return;
    const saved = loadSavedPlace();
    if (saved) {
      manualMode = true;
      setPosition({ ...saved, source: "manual" });
      setStatus(t("gpsFallback"), true);
    } else {
      setStatus(t("gpsSlow"), true);
      $("overlayText").textContent = t("gpsSlow");
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
  const blocked = err.code === err.PERMISSION_DENIED;
  setStatus(blocked ? t("gpsBlocked") : t("gpsWaiting"), true);
  if (blocked) $("overlayText").textContent = t("gpsBlocked");
}

function setPosition(p) {
  const moved = !pos ? Infinity : distanceKm(pos.lat, pos.lon, p.lat, p.lon);
  pos = { ...p };
  $("lat").textContent = pos.lat.toFixed(4) + "°";
  $("lon").textContent = pos.lon.toFixed(4) + "°";
  $("alt").textContent = pos.alt == null ? "–" : fmt.alt(pos.alt);
  $("source").textContent = pos.source === "gps" ? "📡 " + t("srcGps") : "📍 " + t("srcTyped");
  setStatus(pos.source === "gps"
    ? t("usingGps", { m: Math.round(pos.accuracy || 0) })
    : t("usingPlace", { place: pos.label || t("yourLocation") }));
  $("showBtn").disabled = false;
  $("refreshBtn").disabled = false;
  if (!firstSearchDone) $("overlayText").textContent = t("foundYou");

  if (pos.label) $("placeName").textContent = pos.label;
  else if (moved > 1) {
    $("placeName").textContent = `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}`;
    api.placeName(pos.lat, pos.lon, lang()).then((name) => {
      if (name && pos && !pos.label) {
        pos.label = name;
        $("placeName").textContent = name;
        if (pos.source !== "gps") setStatus(t("usingPlace", { place: name }));
      }
    }).catch(() => {});
  }

  if (moved > 0.5) {
    mapView.setMe(pos.lat, pos.lon, radiusKm(), true);
    if (firstSearchDone) loadPlanes();
    if (tab === "airport") renderAirport();
  }
}

function setStatus(text, warn = false) {
  $("locStatus").textContent = text;
  $("locStatus").classList.toggle("warn", warn);
}

function usePlace(place, { save = true, openHex = null } = {}) {
  manualMode = true;
  if (save) savePlace(place);
  setPosition({ ...place, alt: null, accuracy: null, source: "manual" });
  loadPlanes().then(() => { if (openHex) openDetail(openHex); });
}

function savePlace(p) { try { localStorage.setItem(SAVED_PLACE_KEY, JSON.stringify(p)); } catch {} }
function loadSavedPlace() { try { return JSON.parse(localStorage.getItem(SAVED_PLACE_KEY)); } catch { return null; } }

// ---------- Loading aircraft ----------

async function loadPlanes() {
  if (!pos || loading) return;
  loading = true;
  const r = radiusKm();
  firstSearchDone = true;
  $("mapOverlay").hidden = true;
  hideMessage();
  $("refreshBtn").classList.add("spin");
  if (!planes.length) $("summary").textContent = t("scanning");

  try {
    if (!navigator.onLine) throw new Error("offline");
    // 429 = rate limit. The Worker already retried; if still busy, wait 3 s and ask once more.
    let res = await api.fetchStates(pos.lat, pos.lon, r);
    if (res.status === 429) {
      await new Promise((ok) => setTimeout(ok, 3000));
      res = await api.fetchStates(pos.lat, pos.lon, r);
    }
    if (res.status === 429 || res.status === 403) {
      // Still busy: show the last good result for this spot, if we have one.
      if (canReuseLastGood(r)) show(lastGood.states, r, lastGood.time);
      else showMessage(t("busy"));
      return;
    }
    if (!res.data) throw new Error("HTTP " + res.status);
    lastGood = { states: res.data.states || [], time: Date.now(), lat: pos.lat, lon: pos.lon, radiusKm: r };
    show(lastGood.states, r, res.data.stale ? Date.now() - 60000 : null);
  } catch (err) {
    showMessage(!navigator.onLine || err.message === "offline" ? t("offline") : t("loadFail"));
  } finally {
    loading = false;
    $("refreshBtn").classList.remove("spin");
  }
}

function canReuseLastGood(r) {
  return lastGood != null && Date.now() - lastGood.time < LAST_GOOD_MAX_AGE_MS && lastGood.radiusKm >= r &&
    distanceKm(lastGood.lat, lastGood.lon, pos.lat, pos.lon) < LAST_GOOD_MAX_MOVE_KM;
}

// OpenSky-style array -> plane object. See src/lib.js for what each position holds.
function toPlane(s, seenAt = Date.now()) {
  const squawk = s[14] ? String(s[14]) : null;
  const callsign = (s[1] || "").trim();
  return {
    hex: s[0],
    callsign: callsign || (s[17] || s[0] || "?").toUpperCase(),
    hasCallsign: !!callsign,
    isAirline: /^[A-Z]{3}\d/.test(callsign),
    country: s[2],
    lat: s[6], lon: s[5],
    altitude: s[7] != null && s[7] >= 0 ? s[7] : s[13] ?? s[7], // pressure altitude, GPS if negative
    speed: s[9], heading: s[10], vertical: s[11],
    squawk,
    emergency: EMERGENCY_SQUAWKS[squawk] || (s[26] && s[26] !== "none" ? s[26] : null),
    registration: s[17] || null,
    typeCode: s[18] || null,
    military: ((s[19] || 0) & 1) === 1,
    windDir: s[21], windKt: s[22], oat: s[23], mach: s[24], selectedAlt: s[25],
    distance: distanceKm(pos.lat, pos.lon, s[6], s[5]),
    bearing: bearingDeg(pos.lat, pos.lon, s[6], s[5]),
    seenAt,
  };
}

function show(states, r, fetchedAt = null) {
  const seenAt = fetchedAt || Date.now();
  planes = states
    .filter((s) => s[5] != null && s[6] != null && !s[8])
    .map((s) => toPlane(s, seenAt))
    .filter((p) => p.distance <= r)
    .sort((a, b) => a.distance - b.distance);

  lastShown = { r, fetchedAt, at: new Date() };
  checkAlerts();
  announce();
  renderAll();
}

function renderAll() {
  drawStats();
  drawList();
  const shown = visiblePlanes();
  const s = settings();
  mapView.setPlanes(worldPlane ? [...shown, worldPlane] : shown, { selected: selectedHex, labels: s.labels, trails: s.trails && !s.lite });
  if (tab === "sky") renderSky();
  if (tab === "airport") renderBoard();
  if (selectedHex) refreshDetailLive();
}

// ---------- Alerts: new planes, overhead, watchlist ----------

function checkAlerts() {
  const s = settings();
  const items = watchItems();
  const firstLoad = seenHexes.size === 0;
  for (const p of planes) {
    const isNew = !seenHexes.has(p.hex);
    seenHexes.add(p.hex);
    if (alerted.has(p.hex)) continue;

    if (s.overheadAlert && p.distance <= OVERHEAD_KM && p.altitude != null && p.altitude < OVERHEAD_ALT_M) {
      alerted.add(p.hex);
      alertAbout(p, t("overhead", { c: p.callsign }), true);
      continue;
    }
    if (items.length) {
      api.flightInfo(p).then((info) => {
        if (!alerted.has(p.hex) && matchesWatch(p, items, info)) {
          alerted.add(p.hex);
          alertAbout(p, t("watchHit", { c: info?.route?.callsign_iata || p.callsign }), true);
        }
      });
    }
    if (isNew && !firstLoad && s.sound) ping(false);
  }
}

function alertAbout(p, text, loud) {
  const b = $("banner");
  b.replaceChildren(svg(planeSvg(p.heading), "banner-ico"), h("span", {}, text));
  b.style.setProperty("--c", altColor(p.altitude));
  b.hidden = false;
  b.onclick = () => openDetail(p.hex);
  clearTimeout(b.timer);
  b.timer = setTimeout(() => { b.hidden = true; }, 15000);
  if (loud && settings().sound) ping(true);
  if (settings().notify) notify(t("appName"), text);
}

// Screen readers: say how many planes are around when the number changes.
function announce() {
  if (planes.length === lastAnnounced) return;
  lastAnnounced = planes.length;
  const c = planes[0];
  $("srLive").textContent = c ? t("announce", { n: planes.length, c: c.callsign, d: fmt.dist(c.distance) }) : t("noneTitle", { r: fmt.dist(radiusKm(), 0) });
}

// ---------- Stats and list ----------

function drawStats() {
  const set = (id, value, sub) => $(id).replaceChildren(value, ...(sub ? [h("span", { class: "sub" }, sub)] : []));
  if (!planes.length) {
    set("statCount", "0");
    ["statClosest", "statHighest", "statFastest"].forEach((id) => set(id, "–"));
    return;
  }
  const highest = planes.reduce((a, b) => ((b.altitude ?? -1) > (a.altitude ?? -1) ? b : a));
  const fastest = planes.reduce((a, b) => ((b.speed ?? -1) > (a.speed ?? -1) ? b : a));
  set("statCount", fmt.num(planes.length));
  set("statClosest", fmt.dist(planes[0].distance), planes[0].callsign);
  set("statHighest", fmt.altShort(highest.altitude), highest.callsign);
  set("statFastest", fmt.speed(fastest.speed), fastest.callsign);
}

function visiblePlanes() {
  const q = findText.trim().toUpperCase();
  return planes.filter((p) => {
    const info = infoByHex.get(p.hex);
    switch (filter) {
      case "airline": if (!p.isAirline || p.military) return false; break;
      case "private": if (p.isAirline || p.military) return false; break;
      case "military": if (!p.military) return false; break;
      case "rare": if (!(p.typeCode && RARE_TYPES[p.typeCode]) && !p.military && !p.emergency) return false; break;
      case "climb": if (!(p.vertical > 1)) return false; break;
      case "desc": if (!(p.vertical < -1)) return false; break;
    }
    if (!q) return true;
    const hay = [p.callsign, p.registration, p.typeCode, info?.airline?.name, info?.airline?.iata,
      info?.route?.callsign_iata, info?.route?.origin?.iata_code, info?.route?.destination?.iata_code]
      .filter(Boolean).join(" ").toUpperCase();
    return hay.includes(q);
  });
}

function verticalInfo(rate) {
  if (rate == null) return { text: "–", cls: "", arrow: "" };
  if (rate > 1) return { text: t("climbing"), cls: "climbing", arrow: "▲" };
  if (rate < -1) return { text: t("descending"), cls: "descending", arrow: "▼" };
  return { text: t("level"), cls: "", arrow: "▬" };
}

function drawList() {
  const list = $("list");
  const shown = visiblePlanes();
  // Built here (not when data arrives) so it follows language/unit changes.
  if (lastShown) {
    const when = lastShown.fetchedAt
      ? t("staleData", { s: Math.round((lastShown.at - lastShown.fetchedAt) / 1000) })
      : t("updated", { t: fmt.time(lastShown.at) });
    $("summary").textContent = planes.length
      ? t("summary", { n: planes.length, r: fmt.dist(lastShown.r, 0), when }) +
        (shown.length !== planes.length ? ` · ${t("shown", { n: shown.length })}` : "")
      : when;
  }

  if (!planes.length) {
    list.replaceChildren(h("li", { class: "empty" }, h("div", { class: "empty-ico" }, "🌤️"),
      h("b", {}, t("noneTitle", { r: fmt.dist(radiusKm(), 0) })), t("noneHint")));
    return;
  }
  if (!shown.length) {
    list.replaceChildren(h("li", { class: "empty" }, t("noMatch")));
    return;
  }
  list.replaceChildren(...shown.map((p) => {
    const v = verticalInfo(p.vertical);
    const sub = h("div", { class: "sub" }, `${t("ofYou", { dir: compass(p.bearing) })} · ${p.country || "?"}`);
    const tags = badges(p, log).map((b) => h("span", { class: "badge " + b.kind }, t(b.key)));
    const ico = svg(planeSvg(p.heading), "ico");
    ico.style.setProperty("--c", altColor(p.altitude));
    const row = h("button", {
      class: "row" + (p.hex === selectedHex ? " selected" : ""),
      "data-hex": p.hex,
      onclick: () => openDetail(p.hex),
      "aria-label": `${p.callsign}, ${fmt.dist(p.distance)} ${compass(p.bearing)}, ${fmt.alt(p.altitude)}, ${v.text}`,
    },
      ico,
      h("div", { class: "main" },
        h("div", { class: "cs" }, p.callsign, p.typeCode && h("small", {}, p.typeCode), tags),
        sub),
      h("div", { class: "side" },
        h("div", { class: "dist" }, fmt.dist(p.distance)),
        h("div", { class: "altv" }, fmt.altShort(p.altitude), " ", h("span", { class: v.cls }, v.arrow))));
    fillAirlineLine(p, sub, ico);
    return h("li", {}, row);
  }));
}

// "Emirates · DXB → LHR" with the airline logo, once we know.
async function fillAirlineLine(p, el, ico) {
  const info = await api.flightInfo(p);
  if (info) infoByHex.set(p.hex, info);
  if (!el.isConnected || !info) return;
  const parts = [];
  if (info.airline) parts.push(info.airline.name);
  else if (info.privateFlight) parts.push(t("privateGA"));
  if (info.route) parts.push(`${code(info.route.origin)} → ${code(info.route.destination)}`);
  if (parts.length) el.textContent = parts.join(" · ");
  if (info.airline?.iata && !settings().lite) {
    const img = h("img", { src: api.airlineLogo(info.airline.iata), alt: "", class: "logo-sm", loading: "lazy", onerror: (e) => e.target.remove() });
    ico.append(img);
    ico.classList.add("has-logo");
  }
}
const code = (ap) => ap?.iata_code || ap?.icao_code || "?";

// ---------- Details ----------

const findPlane = (hex) => planes.find((p) => p.hex === hex) || (worldPlane?.hex === hex ? worldPlane : null);

function openDetail(hex) {
  const p = findPlane(hex);
  if (!p) return;
  selectedHex = hex;
  $("detail").hidden = false;
  document.querySelectorAll(".row").forEach((r) => r.classList.toggle("selected", r.dataset.hex === hex));
  renderAll();
  mapView.focus(p);
  renderDetail(p);
  $("detailCard").focus({ preventScroll: true });
}

function closeDetail() {
  const was = selectedHex;
  selectedHex = null;
  if (worldPlane && was === worldPlane.hex) { worldPlane = null; if (pos) mapView.setMe(pos.lat, pos.lon, radiusKm(), true); }
  $("detail").hidden = true;
  renderAll();
  document.querySelector(`.row[data-hex="${was}"]`)?.focus({ preventScroll: true });
}

function renderDetail(p) {
  const card = $("detailCard");
  const photo = h("div", { class: "photo" }, placeholderPhoto(settings().lite ? "" : t("lookingPhoto")));
  const title = h("h2", {}, p.callsign);
  const airlineLine = h("p", { class: "airline" });
  const regLine = h("p", {}, p.country ? `${flag(COUNTRY_ISO[p.country])} ${t("registeredIn", { c: p.country })}` : "");
  const badgeRow = h("div", { class: "badges" }, badges(p, log).map((b) => h("span", { class: "badge " + b.kind }, t(b.key))));
  const routeBox = h("div", { class: "route" }, h("div", { class: "note" }, "…"));
  const typeName = p.typeCode && RARE_TYPES[p.typeCode];
  const aircraftGrid = h("div", { class: "grid" },
    cell(t("type"), typeName || p.typeCode || "–", "d-type"),
    cell(t("registration"), p.registration || "–", "d-reg"),
    cell(t("operator"), "–", "d-owner"),
    cell(t("icao"), p.hex.toUpperCase()));
  const inLog = log.hexes.has(p.hex);
  const sawBtn = h("button", { class: "btn btn-cta saw" + (inLog ? " done" : ""), onclick: () => markSeen(p, sawBtn) }, inLog ? t("saved") : "✋ " + t("sawIt"));

  card.replaceChildren(
    h("button", { class: "close", "data-close": "", "aria-label": t("close") }, "×"),
    photo,
    h("div", { class: "d-body" },
      h("div", { class: "d-head" }, title, airlineLine, regLine, badgeRow),
      h("div", { id: "d-alert" }),
      routeBox,
      sawBtn,
      h("div", { class: "d-section" }, t("secLive")),
      h("div", { class: "grid", id: "d-live" }),
      h("div", { class: "d-section" }, t("secWeather")),
      h("div", { class: "grid", id: "d-wx" }),
      h("div", { class: "d-section" }, t("secAircraft")),
      aircraftGrid,
      h("div", { class: "links" },
        h("button", { class: "btn", onclick: () => shareThisPlane(p) }, "📤 " + t("share")),
        h("button", { class: "btn", onclick: () => copyPlaneLink(p) }, "🔗 " + t("copyLink")),
        h("a", { class: "btn", href: "https://www.flightradar24.com/" + encodeURIComponent(p.callsign), target: "_blank", rel: "noopener" }, "Flightradar24 ↗"),
        h("a", { class: "btn", href: "https://adsb.lol/?icao=" + encodeURIComponent(p.hex), target: "_blank", rel: "noopener" }, t("liveTrack") + " ↗"))));
  card.scrollTop = 0;
  refreshDetailLive();

  const lite = settings().lite;
  Promise.all([lite ? null : api.getPhoto(p.hex), api.getAircraft(p.hex)]).then(([ps, ac]) => {
    if (selectedHex !== p.hex) return;
    if (ps) {
      photo.replaceChildren(
        h("img", { src: ps.thumbnail_large?.src || ps.thumbnail?.src, alt: `${p.registration || p.callsign}` }),
        h("span", { class: "credit" }, "📷 ", h("a", { href: ps.link, target: "_blank", rel: "noopener" }, `${ps.photographer} / planespotters.net`)));
      photo.dataset.src = ps.thumbnail_large?.src || "";
    } else if (ac?.url_photo && !lite) {
      photo.replaceChildren(h("img", { src: ac.url_photo, alt: ac.registration || "" }), h("span", { class: "credit" }, "📷 airport-data.com"));
    } else {
      photo.replaceChildren(placeholderPhoto(lite ? "" : t("noPhoto")));
    }
    if (ac) {
      setCell("d-type", [ac.manufacturer, ac.type].filter(Boolean).join(" ") || typeName || p.typeCode || "–");
      setCell("d-reg", ac.registration || p.registration || "–");
      setCell("d-owner", ac.registered_owner || "–");
      if (ac.registered_owner_country_iso_name) {
        regLine.textContent = `${flag(ac.registered_owner_country_iso_name)} ${t("registeredIn", { c: ac.registered_owner_country_name })}`;
      }
    }
  });

  api.flightInfo(p).then((info) => {
    if (selectedHex !== p.hex || !info) return;
    if (info.airline) {
      const iata = info.airline.iata;
      if (info.route?.callsign_iata) title.replaceChildren(p.callsign, h("small", {}, info.route.callsign_iata));
      airlineLine.replaceChildren(
        iata && !lite ? h("img", { src: api.airlineLogo(iata), alt: "", class: "logo-md", onerror: (e) => e.target.remove() }) : "",
        `${info.airline.name} ${flag(info.airline.country_iso)}`.trim());
    } else if (info.privateFlight) {
      airlineLine.textContent = t("privateGA");
    }
    drawRoute(routeBox, info.route, p);
  });
}

function drawRoute(box, route, p) {
  if (!route) {
    box.replaceChildren(h("div", { class: "note" }, p.hasCallsign ? t("routeUnknown") : t("noCallsign")));
    return;
  }
  const o = route.origin, d = route.destination;
  const ap = (a) => h("div", { class: "ap" },
    h("div", { class: "code" }, code(a)),
    h("div", { class: "city" }, `${flag(a.country_iso_name)} ${a.municipality || a.name}`),
    h("div", { class: "city", title: a.name }, a.name));
  const done = distanceKm(o.latitude, o.longitude, p.lat, p.lon);
  const left = distanceKm(p.lat, p.lon, d.latitude, d.longitude);
  const pct = Math.min(100, Math.max(0, (done / (done + left)) * 100));
  box.replaceChildren(ap(o), h("div", { class: "mid", "aria-hidden": "true" }, "✈"), ap(d),
    h("div", { class: "progress", role: "progressbar", "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 },
      h("div", { style: `width:${pct}%` }), h("span", { style: `left:${pct}%` }, "✈")),
    h("div", { class: "note" }, t("flownToGo", { a: fmt.dist(done, 0), b: fmt.dist(left, 0) })));
}

function refreshDetailLive() {
  const live = $("d-live");
  if (!live) return;
  const p = findPlane(selectedHex);
  if (!p) {
    live.replaceChildren(h("div", { class: "stale" }, t("leftArea")));
    return;
  }
  if (p === worldPlane) {
    p.distance = distanceKm(pos.lat, pos.lon, p.lat, p.lon);
    p.bearing = bearingDeg(pos.lat, pos.lon, p.lat, p.lon);
  }
  const v = verticalInfo(p.vertical);
  const el = elevationDeg(p.distance, p.altitude, pos?.alt || 0);
  live.replaceChildren(
    cell(t("alt"), fmt.altBoth(p.altitude)),
    cell(t("speed"), fmt.speedBoth(p.speed)),
    cell(t("heading"), p.heading == null ? "–" : `${Math.round(p.heading)}° ${compass(p.heading)}`),
    cell(t("vertical"), h("span", { class: v.cls }, `${v.arrow} ${v.text} ${v.cls ? fmt.vrate(p.vertical) : ""}`)),
    cell(t("fromYou"), p === worldPlane ? t("farAway", { d: fmt.dist(p.distance, 0) }) : `${fmt.dist(p.distance)} ${compass(p.bearing)}`),
    cell(t("inView"), el > 0 ? t("elevationAt", { e: Math.round(el), dir: compass(p.bearing) }) : t("belowHorizon")),
    cell(t("squawk"), p.squawk || "–"),
    cell(t("selectedAlt"), p.selectedAlt ? `${fmt.num(p.selectedAlt)} ft` : "–"));
  $("d-wx")?.replaceChildren(
    cell(t("wind"), p.windKt != null ? `${Math.round(p.windDir)}° ${compass(p.windDir)} · ${fmt.num(p.windKt)} kt` : "–"),
    cell(t("outsideTemp"), fmt.temp(p.oat)),
    cell(t("mach"), p.mach ? p.mach.toFixed(2) : "–"));
  $("d-alert").replaceChildren(p.emergency ? h("div", { class: "alert" }, `⚠️ ${t("emergency")}: ${p.squawk || ""} ${p.emergency}`) : "");
}

function cell(label, value, id) {
  return h("div", {}, h("span", { class: "k" }, label), h("span", { class: "v", id }, value));
}
function setCell(id, value) { const el = $(id); if (el) el.textContent = value; }

function placeholderPhoto(text) {
  const ph = h("div", { class: "ph" });
  ph.innerHTML = `<div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${PLANE_PATH}"/></svg></div>`;
  ph.firstChild.append(text);
  return ph;
}

// ---------- "I saw it!" and sharing ----------

async function markSeen(p, btn) {
  const info = await api.flightInfo(p);
  log = addToLog({
    hex: p.hex, callsign: p.callsign, type: p.typeCode, reg: p.registration,
    airline: info?.airline?.name || null, country: p.country, place: pos?.label || null,
  });
  btn.textContent = t("saved");
  btn.classList.add("done");
  if (settings().sound) ping(true);
  renderLog();
  if (settings().nick && p.typeCode) api.joinLeaderboard(settings().nick, [p.typeCode]).catch(() => {});
}

async function shareThisPlane(p) {
  const info = await api.flightInfo(p);
  const place = pos?.label || t("yourLocation");
  const url = shareUrl({ lat: pos.lat, lon: pos.lon, radius: radiusKm(), hex: p.hex });
  const photo = document.querySelector("#detailCard .photo")?.dataset.src;
  const res = await shareCard({
    photoUrl: photo,
    callsign: info?.route?.callsign_iata || p.callsign,
    airline: info?.airline?.name,
    route: info?.route ? `${code(info.route.origin)} → ${code(info.route.destination)}` : null,
    lines: [`${fmt.altBoth(p.altitude)}`, `${fmt.speed(p.speed)} · ${fmt.dist(p.distance)} ${compass(p.bearing)}`, p.typeCode ? (RARE_TYPES[p.typeCode] || p.typeCode) : ""].filter(Boolean),
    place, url, text: t("shareText", { c: p.callsign, p: place }),
  });
  if (res === "downloaded") toast("⬇ PNG");
}

async function copyPlaneLink(p) {
  const url = shareUrl({ lat: pos.lat, lon: pos.lon, radius: radiusKm(), hex: p.hex });
  try { await navigator.clipboard.writeText(url); toast(t("linkCopied")); } catch { toast(url); }
}

async function shareHere() {
  if (!pos) return;
  const place = pos.label || t("yourLocation");
  const res = await shareLink({ title: t("appName"), text: t("shareHere", { p: place }), url: shareUrl({ lat: pos.lat, lon: pos.lon, radius: radiusKm() }) });
  if (res === "copied") toast(t("linkCopied"));
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(el.timer);
  el.timer = setTimeout(() => { el.hidden = true; }, 2500);
}

// ---------- Airport tab ----------

async function renderAirport() {
  const box = $("airportBox");
  if (!pos) { box.replaceChildren(h("p", { class: "hint" }, t("finding"))); return; }
  const airports = await api.getAirports().catch(() => null);
  const near = airports && nearestAirport(airports, pos.lat, pos.lon);
  if (!near) { box.replaceChildren(h("p", { class: "hint" }, t("loadFail"))); return; }
  const [icao, iata, name, city, country, , , freqs] = near.airport;
  box.replaceChildren(
    h("div", { class: "card airport" },
      h("div", { class: "k" }, t("nearestAirport")),
      h("div", { class: "ap-title" }, h("span", { class: "code" }, iata || icao), h("span", {}, name)),
      h("div", { class: "sub" }, `${flag(country)} ${city || ""} · ${icao} · ${fmt.dist(near.km)} ${compass(bearingDeg(pos.lat, pos.lon, near.airport[5], near.airport[6]))}`)),
    freqs.length ? h("div", { class: "card" },
      h("div", { class: "k" }, t("frequencies")),
      h("div", { class: "freqs" }, freqs.map(([k, mhz]) => h("span", { class: "freq" }, h("b", {}, k), ` ${mhz.toFixed(3)}`))),
      h("a", { class: "btn btn-wide", href: `https://www.liveatc.net/search/?icao=${encodeURIComponent(icao)}`, target: "_blank", rel: "noopener" }, "🎧 " + t("listenLive") + " ↗")) : "",
    h("div", { class: "card" }, h("div", { class: "k" }, t("board")), h("div", { id: "board" })),
    h("div", { class: "card" }, h("div", { class: "k" }, t("spotting")), h("div", { id: "wx" }, "…")));
  box.dataset.icao = icao;
  box.dataset.iata = iata;
  renderBoard();
  renderWeather();
}

function renderBoard() {
  const el = $("board");
  const box = $("airportBox");
  if (!el) return;
  const codes = [box.dataset.icao, box.dataset.iata].filter(Boolean);
  const rows = { arr: [], dep: [] };
  for (const p of planes) {
    const info = infoByHex.get(p.hex);
    if (!info?.route) continue;
    const o = info.route.origin, d = info.route.destination;
    if (codes.includes(d.icao_code) || codes.includes(d.iata_code)) rows.arr.push([p, info, o]);
    else if (codes.includes(o.icao_code) || codes.includes(o.iata_code)) rows.dep.push([p, info, d]);
  }
  const line = ([p, info, other]) => h("button", { class: "board-row", onclick: () => openDetail(p.hex) },
    h("span", { class: "mono" }, info.route.callsign_iata || p.callsign),
    h("span", {}, `${flag(other.country_iso_name)} ${other.municipality || other.name}`),
    h("span", { class: "muted" }, info.airline?.name || ""),
    h("span", { class: "mono right" }, fmt.altShort(p.altitude)));
  el.replaceChildren(
    rows.arr.length || rows.dep.length ? "" : h("p", { class: "hint" }, t("nothingBoard")),
    rows.arr.length ? h("h4", {}, "🛬 " + t("arriving")) : "", ...rows.arr.map(line),
    rows.dep.length ? h("h4", {}, "🛫 " + t("departing")) : "", ...rows.dep.map(line));
}

async function renderWeather() {
  const el = $("wx");
  const w = await api.getWeather(pos.lat, pos.lon).catch(() => null);
  if (!el || !w) { if (el) el.textContent = "–"; return; }
  const icon = w.weather_code === 0 ? (w.is_day ? "☀️" : "🌙") : w.weather_code <= 3 ? "⛅" : w.weather_code <= 48 ? "🌫️"
    : w.weather_code <= 67 ? "🌧️" : w.weather_code <= 77 ? "❄️" : w.weather_code <= 82 ? "🌦️" : "⛈️";
  const visKm = (w.visibility ?? 0) / 1000;
  const verdict = visKm >= 10 && w.cloud_cover < 50 ? "good" : visKm >= 5 && w.cloud_cover < 85 ? "fair" : "poor";
  el.replaceChildren(
    h("div", { class: "wx-head" }, h("span", { class: "wx-ico" }, icon), h("b", { class: "verdict " + verdict }, t(verdict))),
    h("div", { class: "grid" },
      cell(t("temp"), fmt.temp(w.temperature_2m)),
      cell(t("visibility"), fmt.dist(visKm, 0)),
      cell(t("clouds"), `${w.cloud_cover}%`),
      cell(t("wind"), `${compass(w.wind_direction_10m)} · ${fmt.speed(w.wind_speed_10m / 3.6)}`)));
}

// ---------- Sky tab ----------

function renderSky() {
  renderSkyView($("skyHost"), planes, pos?.alt || 0, { onSelect: openDetail, selected: selectedHex });
}

// ---------- My log tab ----------

async function renderLog() {
  const box = $("logBox");
  const s = settings();
  const typeCounts = {};
  for (const e of log.entries) if (e.type) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  const stat = (k, v) => h("div", { class: "stat" }, h("span", { class: "k" }, k), h("span", { class: "v" }, fmt.num(v)));
  const leaders = h("ol", { class: "leaders" }, h("li", { class: "hint" }, "…"));
  const nickInput = h("input", { type: "text", maxlength: 20, value: s.nick || "", placeholder: t("nickPh"), "aria-label": t("nickPh") });

  box.replaceChildren(
    h("h3", {}, t("logTitle")),
    h("div", { class: "stats" }, stat(t("spotted"), log.entries.length), stat(t("types"), log.types.size), stat(t("airlines"), log.airlines.size), stat(t("countries"), log.countries.size)),
    log.entries.length ? "" : h("p", { class: "hint" }, t("logEmpty")),
    Object.keys(typeCounts).length ? h("div", { class: "typegrid" }, Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, n]) =>
      h("span", { class: "typechip" + (RARE_TYPES[type] ? " rare" : ""), title: RARE_TYPES[type] || type }, h("b", {}, type), ` ×${n}`))) : "",
    log.entries.length ? h("div", { class: "d-section" }, t("recent")) : "",
    h("ul", { class: "recent" }, log.entries.slice(0, 8).map((e) => h("li", {},
      h("span", { class: "mono" }, e.callsign), h("span", {}, [e.type, e.airline].filter(Boolean).join(" · ")),
      h("span", { class: "muted" }, new Date(e.ts).toLocaleDateString(lang()))))),
    h("div", { class: "d-section" }, t("leaderboard")),
    h("form", { class: "join", onsubmit: async (ev) => {
      ev.preventDefault();
      const nick = nickInput.value.trim();
      if (nick.length < 2) return;
      saveSettings({ nick });
      const ok = await api.joinLeaderboard(nick, [...log.types]).catch(() => false);
      toast(ok ? t("joined", { n: nick }) : t("loadFail"));
      loadLeaders(leaders);
    } }, h("p", { class: "hint" }, s.nick ? t("joined", { n: s.nick }) : t("joinBoard")), nickInput, h("button", { class: "btn" }, t("join"))),
    leaders,
    h("p", { class: "links-row" }, h("a", { href: "/stats.html" }, "📊 " + t("statsLink")), " · ", h("a", { href: "/privacy.html" }, "🔒 " + t("privacyLink"))));
  loadLeaders(leaders);
}

async function loadLeaders(el) {
  const stats = await api.getStats().catch(() => null);
  const list = stats?.leaderboard || [];
  el.replaceChildren(...(list.length ? list.slice(0, 10).map((r, i) =>
    h("li", { class: r.nick === settings().nick ? "me" : "" }, h("span", { class: "rank" }, ["🥇", "🥈", "🥉"][i] || i + 1), h("span", {}, r.nick), h("b", {}, r.types)))
    : [h("li", { class: "hint" }, "–")]));
}

// ---------- City links (also good for search engines) ----------

const CITY_LINKS = [["london", "London"], ["dubai", "Dubai"], ["colombo", "Colombo"], ["new-york", "New York"], ["singapore", "Singapore"],
  ["tokyo", "Tokyo"], ["paris", "Paris"], ["frankfurt", "Frankfurt"], ["istanbul", "Istanbul"], ["doha", "Doha"], ["delhi", "Delhi"],
  ["sydney", "Sydney"], ["los-angeles", "Los Angeles"], ["hong-kong", "Hong Kong"], ["amsterdam", "Amsterdam"]];
function renderCityLinks() {
  $("cityLinks").replaceChildren(t("nearbyCities") + " ", ...CITY_LINKS.flatMap(([slug, name], i) =>
    [i ? " · " : "", h("a", { href: `/over/${slug}` }, name)]));
}

// ---------- Settings ----------

function fillLanguageSelect() {
  $("langSelect").replaceChildren(...Object.entries(LANGUAGES).map(([code, name]) => h("option", { value: code }, name)));
}

function openSettings() {
  const form = $("settingsForm");
  const s = settings();
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === "checkbox") el.checked = !!s[el.name];
    else el.value = el.name === "lang" ? lang() : String(s[el.name]);
  }
  $("settingsDlg").showModal();
}

async function onSettingChange(e) {
  const el = e.target;
  if (!el.name) return;
  let value = el.type === "checkbox" ? el.checked : el.value;
  if (el.name === "radius") value = Number(value);
  if (el.name === "notify" && value) value = await askNotifications();
  if (el.name === "notify") el.checked = value;
  saveSettings({ [el.name]: value });

  if (el.name === "lang") { await setLanguage(value); refreshFormat(); fillLanguageSelect(); $("langSelect").value = value; renderCityLinks(); renderLog(); }
  if (el.name === "units" || el.name === "clock") { refreshFormat(); tick(); if (pos) setPosition(pos); }
  if (el.name === "mapStyle" || el.name === "theme") applyMapStyle();
  if (el.name === "radius") { setRadius(value); if (pos) { mapView.setMe(pos.lat, pos.lon, value, true); if (firstSearchDone) loadPlanes(); } }
  if (el.name === "lite") setAuto();
  renderAll();
  if (selectedHex && ["lang", "units", "lite"].includes(el.name)) renderDetail(findPlane(selectedHex));
  if (tab === "airport" && ["lang", "units"].includes(el.name)) renderAirport();
}

// The "Dark" map follows the theme: with the light theme it uses the light map.
function applyMapStyle() {
  const style = settings().mapStyle;
  mapView.setStyle(style === "dark" && document.documentElement.dataset.theme === "light" ? "light" : style);
}

function setAuto() {
  clearInterval(autoTimer);
  if ($("autoRefresh").checked) {
    autoTimer = setInterval(() => { if (firstSearchDone && !document.hidden) loadPlanes(); }, settings().lite ? 30000 : 15000);
  }
}

// ---------- Tabs ----------

function showTab(name) {
  tab = name;
  document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".tabpanel").forEach((p) => { p.hidden = p.id !== "tab-" + name; });
  if (name === "sky") renderSky();
  if (name === "airport") renderAirport();
  if (name === "me") renderLog();
}

// ---------- Wiring ----------

function wireUi() {
  $("showBtn").addEventListener("click", loadPlanes);
  $("refreshBtn").addEventListener("click", loadPlanes);
  $("autoRefresh").addEventListener("change", setAuto);
  $("shareBtn").addEventListener("click", shareHere);
  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsForm").addEventListener("change", onSettingChange);
  $("settingsForm").addEventListener("input", (e) => { if (e.target.name === "watchlist") saveSettings({ watchlist: e.target.value }); });

  document.querySelectorAll('input[name="radius"]').forEach((el) => el.addEventListener("change", () => {
    if (!pos) return;
    mapView.setMe(pos.lat, pos.lon, radiusKm(), true);
    if (firstSearchDone) loadPlanes();
  }));

  $("locForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("locInput").value.trim();
    if (!text) return;
    const coords = parseCoordinates(text);
    $("locInput").blur();
    if (coords) { $("locInput").value = ""; usePlace({ ...coords, label: null }); return; }
    setStatus(t("searching", { q: text }));
    try {
      const place = await api.searchPlace(text);
      if (!place) { setStatus(t("notFound", { q: text }), true); return; }
      $("locInput").value = "";
      usePlace(place);
    } catch {
      setStatus(t("notFound", { q: text }), true);
    }
  });

  $("gpsBtn").addEventListener("click", () => {
    manualMode = false;
    try { localStorage.removeItem(SAVED_PLACE_KEY); } catch {}
    if (lastGps) setPosition(lastGps);
    else { setStatus(t("gpsWaiting")); startGps(); }
  });

  document.querySelectorAll(".tabs [role=tab]").forEach((b) => {
    b.addEventListener("click", () => showTab(b.dataset.tab));
    b.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const tabs = [...document.querySelectorAll(".tabs [role=tab]")];
      const next = tabs[(tabs.indexOf(b) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      showTab(next.dataset.tab);
    });
  });

  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
    filter = c.dataset.filter;
    document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === c));
    renderAll();
  }));

  $("findInput").addEventListener("input", (e) => { findText = e.target.value; renderAll(); });
  $("findForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = findText.trim();
    if (!q || visiblePlanes().length) return;
    // Not near you: search the whole world.
    $("summary").textContent = t("findWorld", { q });
    const found = await api.findFlight(q).catch(() => []);
    const s = found.find((x) => x[5] != null && x[6] != null);
    if (!s || !pos) { $("summary").textContent = t("findNone", { q }); return; }
    worldPlane = toPlane(s);
    findText = "";
    $("findInput").value = "";
    renderAll();
    openDetail(worldPlane.hex);
  });

  $("detail").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDetail(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selectedHex && !$("settingsDlg").open && $("ar").hidden) closeDetail();
  });

  const startAR = () => ar.start();
  $("arBtn").addEventListener("click", startAR);
  $("arBtn2").addEventListener("click", startAR);

  window.addEventListener("offline", () => showMessage(t("offline")));
  window.addEventListener("online", hideMessage);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && firstSearchDone && $("autoRefresh").checked) loadPlanes(); });

  // "Install app" button when the browser offers it (Android/desktop Chrome).
  let installEvent = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; $("installBtn").hidden = false; });
  $("installBtn").addEventListener("click", async () => { installEvent?.prompt(); installEvent = null; $("installBtn").hidden = true; });

  translatePage();
}

function showMessage(text) { $("message").textContent = text; $("message").hidden = false; }
function hideMessage() { $("message").hidden = true; }

function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}
