// Flight monitor: follow one aircraft from departure to arrival, or replay a recorded flight.
//   /flight/                  flights being followed
//   /flight/<id>              live
//   /flight/<id>/replay       replay of the recording
// Observed values come straight from the aircraft (via adsb.lol). Phases, progress and ETA
// are inferred here and labelled ◇. ATC is links to LiveATC only.
/* global L */

import { distanceKm, compass, nearestAirport } from "./geo.js";
import { applyLook } from "./settings.js";
import { getRoute, getAirports, airlineLogo } from "./api.js";
import { planeSvg } from "./mapview.js";

applyLook();

const $ = (id) => document.getElementById(id);
const [, id, sub] = location.pathname.split("/").filter(Boolean);
const mode = sub === "replay" ? "replay" : "live";
const GAP_MS = 5 * 60_000;

let session = null, events = [], points = [], route = null, airports = null;
let map, trackLayer, planeMarker, cursorIdx = 0, playing = null;

const num = (n) => (n == null ? "–" : Math.round(n).toLocaleString());
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const hhmmss = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const flag = (iso) => /^[A-Z]{2}$/.test(iso || "") ? String.fromCodePoint(...[...iso].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

if (!id) showList(); else start();

// ---------- List of followed flights ----------

async function showList() {
  $("fmMain").hidden = true;
  $("fmList").hidden = false;
  $("fmCallsign").textContent = "Followed flights";
  $("fmStatus").hidden = true;
  $("fmModeLink").hidden = true;
  const data = await fetch("/api/flights").then((r) => r.json()).catch(() => ({ flights: [] }));
  const items = (data.flights || []).map((f) => h("li", {},
    h("a", { href: `/flight/${f.id}${f.status === "active" ? "" : "/replay"}` },
      h("b", { class: "mono" }, f.callsign || f.icao24.toUpperCase()),
      h("span", {}, [f.origin, f.destination].filter(Boolean).join(" → ") || f.type_code || ""),
      h("span", { class: "pill " + f.status }, statusLabel(f.status)),
      h("span", { class: "muted" }, `${hhmm(f.started_at)} · ${f.points} points`))));
  $("fmListItems").replaceChildren(...(items.length ? items : [h("li", { class: "hint" }, "Nobody is following a flight right now.")]));
}

// ---------- One flight ----------

async function start() {
  $("fmModeLink").textContent = mode === "replay" ? "Live view" : "Replay";
  $("fmModeLink").href = mode === "replay" ? `/flight/${id}` : `/flight/${id}/replay`;
  setupMap();

  const [d, hist] = await Promise.all([
    fetch(`/api/flights/${id}`).then((r) => (r.ok ? r.json() : null)),
    fetch(`/api/flights/${id}/history`).then((r) => (r.ok ? r.json() : { points: [] })),
  ]).catch(() => [null, null]);
  if (!d) { $("fmCallsign").textContent = "Flight not found"; $("fmStatus").textContent = "–"; return; }
  session = d.session; events = d.events; points = hist?.points || [];
  document.title = `${session.callsign || session.icao24.toUpperCase()} – Flight monitor`;
  if (session.callsign) route = await getRoute(session.callsign).catch(() => null);
  airports = await getAirports().catch(() => null);

  renderHeader();
  cursorIdx = points.length - 1;
  renderAll();
  loadWeather();

  if (mode === "replay") setupReplay();
  else if (session.status === "active") {
    setInterval(pollTelemetry, 10_000);
    setInterval(refreshSession, 60_000);
    setInterval(renderAge, 1000);
  }
  renderAge();
}

async function pollTelemetry() {
  if (document.hidden) return;
  const t = await fetch(`/api/flights/${id}/telemetry`).then((r) => r.json()).catch(() => null);
  const o = t?.observation;
  if (o && (!points.length || o.ts > points[points.length - 1].ts)) {
    points.push(o);
    cursorIdx = points.length - 1;
    renderAll();
  }
  if (t?.status && t.status !== session.status) refreshSession();
}

async function refreshSession() {
  const d = await fetch(`/api/flights/${id}`).then((r) => r.json()).catch(() => null);
  if (!d) return;
  session = d.session; events = d.events;
  renderHeader();
  renderAll();
}

function statusLabel(s) {
  return { active: "● Tracking live", landed: "✓ Landed", lost: "Signal lost", ended: "Ended" }[s] || s;
}

function renderHeader() {
  $("fmCallsign").replaceChildren(session.callsign || session.icao24.toUpperCase(),
    route?.callsign_iata ? h("small", {}, route.callsign_iata) : "");
  const airline = route?.airline;
  $("fmSub").replaceChildren(
    airline?.iata ? h("img", { src: airlineLogo(airline.iata), alt: "", class: "logo-md", onerror: (e) => e.target.remove() }) : "",
    [airline?.name, session.type_code, session.registration, `ICAO24 ${session.icao24.toUpperCase()}`].filter(Boolean).join(" · "));
  const st = mode === "replay" ? "↺ Replay" : statusLabel(session.status);
  $("fmStatus").textContent = st;
  $("fmStatus").className = "pill " + (mode === "replay" ? "replay" : session.status);
}

// "Last data 12 s ago" and a clear message when data stops (never invented).
function renderAge() {
  const last = points[points.length - 1];
  if (!last || mode === "replay") { $("fmAge").textContent = ""; $("fmGap").hidden = true; return; }
  const age = Date.now() - last.ts;
  $("fmAge").textContent = age < 90_000 ? `data ${Math.round(age / 1000)} s old` : `no data for ${Math.round(age / 60000)} min`;
  $("fmAge").classList.toggle("stale", age >= 90_000);
  const gap = session.status === "active" && age >= 90_000;
  $("fmGap").hidden = !gap;
  if (gap) $("fmGap").textContent = `No position received for ${Math.round(age / 60000)} min. The aircraft is probably outside receiver coverage (common over oceans and remote areas). Recording continues and the track resumes when a receiver hears it again.`;
}

function renderAll() {
  const p = points[cursorIdx] || points[points.length - 1];
  renderTiles(p);
  renderMap(p);
  renderPhase(p);
  renderRoute(p);
  renderCharts(p);
  renderEvents(p);
  renderAtc(p);
}

// ---------- Telemetry tiles (observed) ----------

function renderTiles(p) {
  $("tAlt").textContent = !p ? "–" : p.on_ground ? "On ground" : `${num(p.alt_ft)} ft`;
  $("tGs").textContent = p?.gs_kt != null ? `${num(p.gs_kt)} kt` : "–";
  $("tHdg").textContent = p?.track_deg != null ? `${num(p.track_deg)}° ${compass(p.track_deg)}` : "–";
  $("tVr").textContent = p?.vrate_fpm != null ? `${p.vrate_fpm > 0 ? "+" : ""}${num(p.vrate_fpm)} fpm` : "–";
  $("tSq").textContent = p?.squawk || "–";
  $("tSq").classList.toggle("danger", ["7500", "7600", "7700"].includes(p?.squawk));
}

// ---------- Map ----------

function setupMap() {
  map = L.map("fmMap", { zoomControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 16 }).setView([30, 10], 3);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  const light = document.documentElement.dataset.theme === "light";
  L.tileLayer(ESRI + `World_${light ? "Light" : "Dark"}_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { attribution: "Map &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors", maxZoom: 16 }).addTo(map);
  L.tileLayer(ESRI + `World_${light ? "Light" : "Dark"}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, pane: "overlayPane" }).addTo(map);
  trackLayer = L.layerGroup().addTo(map);
}

let fitted = false;
function renderMap(p) {
  trackLayer.clearLayers();
  const upto = mode === "replay" ? points.slice(0, cursorIdx + 1) : points;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const faint = getComputedStyle(document.documentElement).getPropertyValue("--faint").trim();

  // Planned route: faint dashed line between the airports.
  if (route?.origin && route?.destination) {
    const o = [route.origin.latitude, route.origin.longitude], d = [route.destination.latitude, route.destination.longitude];
    L.polyline([o, d], { color: faint, weight: 1.5, dashArray: "2 8", interactive: false }).addTo(trackLayer);
    for (const [ap, ll] of [[route.origin, o], [route.destination, d]]) {
      L.circleMarker(ll, { radius: 5, color: faint, fillColor: faint, fillOpacity: 1, weight: 2 }).bindTooltip(`${ap.iata_code || ap.icao_code} · ${ap.name}`).addTo(trackLayer);
    }
  }

  // Recorded track; gaps (no data for 5+ min) drawn as dashed "no data" lines.
  let seg = [];
  const flush = () => { if (seg.length > 1) L.polyline(seg, { color: accent, weight: 3, opacity: 0.9, interactive: false }).addTo(trackLayer); seg = []; };
  upto.forEach((pt, i) => {
    const prev = upto[i - 1];
    if (prev && pt.ts - prev.ts > GAP_MS) {
      flush();
      L.polyline([[prev.lat, prev.lon], [pt.lat, pt.lon]], { color: faint, weight: 2, dashArray: "4 6", interactive: false })
        .bindTooltip(`No data for ${Math.round((pt.ts - prev.ts) / 60000)} min`).addTo(trackLayer);
    }
    seg.push([pt.lat, pt.lon]);
  });
  flush();

  if (p) {
    const icon = L.divIcon({ className: "", html: `<div class="plane selected" style="--c:${accent}">${planeSvg(p.track_deg)}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    planeMarker = L.marker([p.lat, p.lon], { icon, interactive: false }).addTo(trackLayer);
  }
  if (!fitted && upto.length) {
    fitted = true;
    // Fit the recorded track plus where it's heading (the departure airport may be an ocean away).
    const pts = (mode === "replay" ? points : upto).map((x) => [x.lat, x.lon]);
    if (route?.destination && session.status === "active") pts.push([route.destination.latitude, route.destination.longitude]);
    map.fitBounds(pts, { padding: [40, 40], maxZoom: 8 });
  } else if (p && mode === "live" && !map.getBounds().contains([p.lat, p.lon])) {
    map.panTo([p.lat, p.lon]);
  }
}

// ---------- Phase and route (inferred) ----------

function phaseAt(ts) {
  // Latest phase event up to this time; replay uses the recording, live uses the session.
  if (mode === "live" && session.status === "landed") return "landed";
  let ph = null;
  for (const e of events) {
    if (e.ts > ts) break;
    if (["climb", "cruise", "descent", "approach"].includes(e.kind)) ph = e.kind;
    if (e.kind === "takeoff" && !ph) ph = "climb";
    if (e.kind === "landing") ph = "landed";
  }
  if (mode === "live" && session.phase && session.phase !== "level") ph = session.phase === "ground" && ph === "landed" ? "landed" : session.phase;
  const p = points[cursorIdx];
  if (!ph && p) ph = p.on_ground ? "ground" : "cruise";
  return ph;
}

function renderPhase(p) {
  const ph = p ? phaseAt(p.ts) : null;
  const order = ["ground", "climb", "cruise", "descent", "approach", "landed"];
  const idx = order.indexOf(ph);
  document.querySelectorAll("#fmPhases li").forEach((li, i) => {
    li.classList.toggle("done", idx > i);
    li.classList.toggle("now", idx === i);
  });
  const names = { ground: "On ground", climb: "Climbing", cruise: "Cruising", descent: "Descending", approach: "Approaching", landed: "Landed", level: "Level" };
  $("tPhase").textContent = names[ph] || "–";
}

function renderRoute(p) {
  const box = $("fmRoute");
  if (!route?.origin || !route?.destination) {
    box.replaceChildren(h("p", { class: "hint" }, session.callsign ? "Route not known for this flight, so progress and arrival estimate aren't available." : "This aircraft isn't sending a flight number, so its route is unknown."));
    return;
  }
  const o = route.origin, d = route.destination;
  const ap = (a, end) => h("div", { class: "ap" + (end ? " end" : "") },
    h("div", { class: "code" }, a.iata_code || a.icao_code), h("div", { class: "city" }, `${flag(a.country_iso_name)} ${a.municipality || a.name}`));
  let line = null, pct = 0;
  if (p) {
    const done = distanceKm(o.latitude, o.longitude, p.lat, p.lon);
    const left = distanceKm(p.lat, p.lon, d.latitude, d.longitude);
    pct = Math.max(0, Math.min(100, (done / (done + left)) * 100));
    const landed = session.status === "landed" && mode === "live";
    const eta = !landed && p.gs_kt > 100 ? Math.round((left / (p.gs_kt * 1.852)) * 60 + 8) : null;
    line = h("div", { class: "note" },
      `${num(done)} km flown · ${num(left)} km to go`,
      eta != null ? h("span", { class: "tag-inf" }, ` · ◇ arrives ~${hhmm(p.ts + eta * 60000)} (estimate)`) : "");
  }
  box.replaceChildren(h("div", { class: "route" }, ap(o), h("div", { class: "mid" }, "✈"), ap(d, true),
    h("div", { class: "progress" }, h("div", { style: `width:${pct}%` }), h("span", { style: `left:${pct}%` }, "✈")), line));
}

// ---------- Charts (two separate charts: never two scales on one) ----------

function renderCharts(p) {
  drawChart($("chAlt"), "alt_ft", (v) => `${num(v)} ft`, p);
  drawChart($("chGs"), "gs_kt", (v) => `${num(v)} kt`, p);
}

function drawChart(host, key, fmtVal, cursor) {
  const pts = points.filter((x) => x[key] != null);
  if (pts.length < 2) { host.innerHTML = `<p class="hint">Not enough data yet.</p>`; return; }
  const W = 400, H = 120, L0 = 44, R0 = 8, T0 = 8, B0 = 20;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts || t0 + 1;
  const max = Math.max(1, ...pts.map((x) => x[key])) * 1.08;
  const x = (ts) => L0 + ((ts - t0) / Math.max(1, t1 - t0)) * (W - L0 - R0);
  const y = (v) => T0 + (1 - v / max) * (H - T0 - B0);
  // line, broken at reception gaps
  let d = "";
  pts.forEach((pt, i) => { d += `${i && pt.ts - pts[i - 1].ts <= GAP_MS ? "L" : "M"}${x(pt.ts).toFixed(1)},${y(pt[key]).toFixed(1)}`; });
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = max * f, yy = y(v).toFixed(1);
    return `<line x1="${L0}" x2="${W - R0}" y1="${yy}" y2="${yy}" class="grid"/>${f ? `<text x="${L0 - 6}" y="${yy}" class="axis" text-anchor="end" dominant-baseline="middle">${v >= 1000 ? (v / 1000).toFixed(0) + "k" : Math.round(v)}</text>` : ""}`;
  }).join("");
  const ticks = [0, 0.5, 1].map((f) => {
    const ts = t0 + (t1 - t0) * f;
    return `<text x="${x(ts)}" y="${H - 4}" class="axis" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${hhmm(ts)}</text>`;
  }).join("");
  const cur = cursor && cursor[key] != null ? `<line x1="${x(cursor.ts)}" x2="${x(cursor.ts)}" y1="${T0}" y2="${H - B0}" class="cursor"/><circle cx="${x(cursor.ts)}" cy="${y(cursor[key])}" r="4" class="dot"/>` : "";
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${key === "alt_ft" ? "Altitude" : "Ground speed"} over time">
    ${grid}${ticks}<path d="${d}" class="line"/>${cur}
    <g class="hover" visibility="hidden"><line class="cross" y1="${T0}" y2="${H - B0}"/><circle r="4" class="dot"/></g>
    <rect x="${L0}" y="0" width="${W - L0 - R0}" height="${H}" fill="transparent" class="hit"/></svg><div class="tip" hidden></div>`;

  // Hover: crosshair + tooltip on the nearest observation.
  const svg = host.querySelector("svg"), g = host.querySelector(".hover"), tip = host.querySelector(".tip");
  host.querySelector(".hit").addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const ts = t0 + ((((e.clientX - r.left) / r.width) * W - L0) / (W - L0 - R0)) * (t1 - t0);
    let best = pts[0];
    for (const pt of pts) if (Math.abs(pt.ts - ts) < Math.abs(best.ts - ts)) best = pt;
    const cx = x(best.ts), cy = y(best[key]);
    g.setAttribute("visibility", "visible");
    g.querySelector(".cross").setAttribute("x1", cx); g.querySelector(".cross").setAttribute("x2", cx);
    g.querySelector(".dot").setAttribute("cx", cx); g.querySelector(".dot").setAttribute("cy", cy);
    tip.hidden = false;
    tip.textContent = `${hhmmss(best.ts)} · ${fmtVal(best[key])}`;
    tip.style.left = `${(cx / W) * 100}%`;
  });
  host.querySelector(".hit").addEventListener("pointerleave", () => { g.setAttribute("visibility", "hidden"); tip.hidden = true; });
}

// ---------- Timeline ----------

const EVENT_TEXT = {
  started: ["📍", "Started following"], takeoff: ["🛫", "Takeoff"], climb: ["↗", "Climbing"], cruise: ["➡", "Cruise"],
  descent: ["↘", "Descending"], approach: ["🛬", "Approach"], landing: ["🛬", "Landing"], signal_lost: ["📡", "Signal lost"],
  signal_regained: ["📡", "Signal back"], squawk: ["⚠️", "Emergency squawk"],
};
function renderEvents(p) {
  const until = mode === "replay" && p ? p.ts : Infinity;
  const list = events.filter((e) => e.ts <= until);
  $("fmEvents").replaceChildren(...(list.length ? list.slice().reverse().map((e) => {
    const [ico, text] = EVENT_TEXT[e.kind] || ["•", e.kind];
    return h("li", { class: e.kind },
      h("span", { class: "ev-ico" }, ico),
      h("span", { class: "mono" }, hhmm(e.ts)),
      h("span", {}, text, e.detail ? h("span", { class: "muted" }, ` · ${e.detail}`) : ""),
      h("span", { class: e.inferred ? "tag-inf" : "tag-obs" }, e.inferred ? "◇ inferred" : "● observed"));
  }) : [h("li", { class: "hint" }, "No events yet.")]));
}

// ---------- ATC (links to authorised listening only) ----------

function airportByIcao(icao) {
  return icao && airports ? airports.find((a) => a[0] === icao) : null;
}

function renderAtc(p) {
  const box = $("fmAtc");
  if (!airports || !p) { box.textContent = "…"; return; }
  const ph = phaseAt(p.ts);
  const origin = airportByIcao(route?.origin?.icao_code) || null;
  const dest = airportByIcao(route?.destination?.icao_code) || null;
  // For context en route, prefer airports with airline service (they're the ones with feeds).
  const near = nearestAirport(airports.filter((a) => a[1]), p.lat, p.lon) || nearestAirport(airports, p.lat, p.lon);
  const kmTo = (a) => (a ? distanceKm(p.lat, p.lon, a[5], a[6]) : Infinity);

  // Which controller is the flight most likely talking to? (inferred from phase and position)
  let stage, where;
  if ((ph === "ground" || ph === "climb") && kmTo(origin) < 80) { stage = ph === "ground" ? 0 : 1; where = origin; }
  else if (ph === "landed" || ((ph === "approach" || ph === "descent" || ph === "ground") && kmTo(dest) < 120)) { stage = ph === "landed" || ph === "ground" ? 4 : 3; where = dest; }
  else { stage = 2; where = near?.airport; }
  if (!where) where = near?.airport;

  const stages = ["Ground / Tower", "Departure", "Area control", "Approach / Tower", "Ground"];
  const wanted = [["GND", "DEL", "TWR", "CLD"], ["TWR", "DEP", "APP"], [], ["APP", "TWR", "ATIS"], ["TWR", "GND"]][stage];
  const freqs = where ? where[7].filter(([k]) => !wanted.length || wanted.includes(k)) : [];

  box.replaceChildren(
    h("ol", { class: "atc-stages" }, stages.map((s, i) => h("li", { class: i === stage ? "now" : i < stage ? "done" : "" }, s))),
    h("p", { class: "atc-now" }, h("span", { class: "tag-inf" }, "◇ likely now: "), h("b", {}, stages[stage]),
      where ? ` · ${where[1] || where[0]} ${where[2]}` : ""),
    stage === 2
      ? h("p", { class: "hint" }, `En route, the flight talks to an area control centre whose frequency changes sector by sector and isn't published per flight. Nearest airport for context: ${near ? `${near.airport[1] || near.airport[0]} (${num(near.km)} km)` : "–"}.`)
      : freqs.length ? h("div", { class: "freqs" }, freqs.map(([k, mhz]) => h("span", { class: "freq" }, h("b", {}, k), ` ${mhz.toFixed(3)}`))) : h("p", { class: "hint" }, "No published frequencies for this airport in our data."),
    where ? liveAtcLink(where) : "",
    // En route: what comes next at the destination.
    stage === 2 && dest ? h("div", { class: "atc-next" },
      h("p", { class: "atc-now" }, h("span", { class: "tag-inf" }, "◇ coming up: "), h("b", {}, "Approach / Tower"), ` · ${dest[1] || dest[0]} ${dest[2]} (${num(kmTo(dest))} km)`),
      h("div", { class: "freqs" }, dest[7].filter(([k]) => ["APP", "TWR", "ATIS"].includes(k)).map(([k, mhz]) => h("span", { class: "freq" }, h("b", {}, k), ` ${mhz.toFixed(3)}`))),
      liveAtcLink(dest)) : "",
    h("p", { class: "hint" }, "Status: not connected. Audio opens on LiveATC in a new tab, where available."));
}

const liveAtcLink = (a) => h("a", { class: "btn btn-wide", href: `https://www.liveatc.net/search/?icao=${encodeURIComponent(a[0])}`, target: "_blank", rel: "noopener" },
  `🎧 Find live feeds for ${a[1] || a[0]} on LiveATC ↗`);

// ---------- Weather (observed METAR) ----------

async function loadWeather() {
  const ids = [route?.origin?.icao_code, route?.destination?.icao_code].filter(Boolean);
  if (!ids.length && points.length && airports) {
    const n = nearestAirport(airports, points[points.length - 1].lat, points[points.length - 1].lon);
    if (n) ids.push(n.airport[0]);
  }
  if (!ids.length) { $("fmWx").textContent = "No airport known for this flight."; return; }
  const d = await fetch(`/api/metar?ids=${ids.join(",")}`).then((r) => r.json()).catch(() => null);
  const list = d?.metars || [];
  $("fmWx").replaceChildren(...(list.length ? list.map((m) => h("div", { class: "metar" },
    h("div", {}, h("b", {}, m.icao), ` ${m.name || ""}`, m.category ? h("span", { class: "pill cat-" + m.category }, m.category) : ""),
    h("div", { class: "muted" }, [m.temp != null ? `${m.temp} °C` : null, m.wspd != null ? `wind ${m.wdir}° ${m.wspd} kt` : null, m.visib ? `vis ${m.visib}` : null].filter(Boolean).join(" · ")),
    h("code", {}, m.raw))) : [h("span", {}, "No weather report available.")]));
}

// ---------- Replay ----------

function setupReplay() {
  $("fmReplay").hidden = false;
  const slider = $("fmSlider");
  slider.max = Math.max(0, points.length - 1);
  cursorIdx = 0;
  slider.value = 0;
  const show = () => { $("fmReplayTime").textContent = points[cursorIdx] ? hhmmss(points[cursorIdx].ts) : ""; renderAll(); };
  slider.addEventListener("input", () => { cursorIdx = Number(slider.value); show(); });
  $("fmPlay").addEventListener("click", () => {
    if (playing) { clearInterval(playing); playing = null; $("fmPlay").textContent = "▶"; return; }
    if (cursorIdx >= points.length - 1) cursorIdx = 0;
    $("fmPlay").textContent = "❚❚";
    let t = points[cursorIdx]?.ts || 0;
    playing = setInterval(() => {
      t += 200 * Number($("fmSpeed").value);
      while (cursorIdx < points.length - 1 && points[cursorIdx + 1].ts <= t) cursorIdx++;
      if (points[cursorIdx + 1] && points[cursorIdx + 1].ts - t > GAP_MS) t = points[cursorIdx + 1].ts; // skip gaps
      slider.value = cursorIdx;
      show();
      if (cursorIdx >= points.length - 1) { clearInterval(playing); playing = null; $("fmPlay").textContent = "▶"; }
    }, 200);
  });
  show();
}
