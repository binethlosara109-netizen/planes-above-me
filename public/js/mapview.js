// The live map: Leaflet, map styles, aircraft markers (clustered near busy
// airports), smooth movement between updates, flight trails and a 5-minute
// prediction line for the selected plane.
/* global L */

import { deadReckon, destination } from "./geo.js";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const ESRI_ATTR = "Map &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors";
const STYLES = {
  dark: [ESRI + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", ESRI + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"],
  light: [ESRI + "Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", ESRI + "Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"],
  satellite: [ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", ESRI + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
};

// Top-down aeroplane icon, pointing up (north).
export const PLANE_PATH = "M12 1.5c.9 0 1.5 1 1.5 2.2v5.6l8 4.8v2.2l-8-2.5v5l2.3 1.8v1.7L12 21.4l-3.8.9v-1.7l2.3-1.8v-5l-8 2.5v-2.2l8-4.8V3.7c0-1.2.6-2.2 1.5-2.2z";
export const planeSvg = (deg = 0) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(${Number(deg) || 0}deg)"><path d="${PLANE_PATH}"/></svg>`;

// Colour for an altitude in metres (same steps as the map legend: 0, 5k, 15k, 25k, 35k ft).
export function altColor(m) {
  const ft = m == null ? 0 : m * 3.28084;
  const v = ft >= 35000 ? 4 : ft >= 25000 ? 3 : ft >= 15000 ? 2 : ft >= 5000 ? 1 : 0;
  return `var(--alt${v})`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createMap(el, { onSelect }) {
  const map = L.map(el, { zoomControl: false, worldCopyJump: true, zoomSnap: 0.25, minZoom: 2, maxZoom: 18 }).setView([20, 10], 2);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  let tiles = [];
  function setStyle(style) {
    tiles.forEach((t) => t.remove());
    const [base, labels] = STYLES[style] || STYLES.dark;
    tiles = [
      L.tileLayer(base, { attribution: ESRI_ATTR, maxZoom: style === "satellite" ? 18 : 16, className: "tiles-" + style }).addTo(map),
      L.tileLayer(labels, { maxZoom: 16, pane: "overlayPane", className: "labels-" + style }).addTo(map),
    ];
  }

  // Busy airports: group nearby planes into a numbered bubble until you zoom in.
  const cluster = L.markerClusterGroup({
    maxClusterRadius: 34,
    disableClusteringAtZoom: 11,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: (c) => L.divIcon({ className: "", html: `<div class="cluster">${c.getChildCount()}</div>`, iconSize: [34, 34] }),
  }).addTo(map);

  const trailLayer = L.layerGroup().addTo(map);
  const markers = new Map(); // hex -> marker
  const trails = new Map(); // hex -> [[lat, lon], ...]
  const trailLines = new Map(); // hex -> polyline
  let prediction = null;
  let me = null, circle = null;
  let planes = [];
  let opts = { selected: null, labels: true, trails: true };

  function icon(p) {
    const cls = ["plane", p.hex === opts.selected && "selected", p.emergency && "emergency", p.military && "military"].filter(Boolean).join(" ");
    return L.divIcon({
      className: "",
      html: `<div class="${cls}" style="--c:${altColor(p.altitude)}">${planeSvg(p.heading)}${opts.labels || p.hex === opts.selected ? `<span class="tag">${esc(p.callsign)}</span>` : ""}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
  }

  // Draw the latest planes. Each keeps its report time so we can glide it forward.
  function setPlanes(list, newOpts) {
    opts = { ...opts, ...newOpts };
    planes = list;
    const seen = new Set();
    const toAdd = [];
    for (const p of list) {
      seen.add(p.hex);
      let m = markers.get(p.hex);
      if (!m) {
        m = L.marker([p.lat, p.lon], { icon: icon(p), keyboard: false, title: p.callsign });
        m.on("click", () => onSelect(p.hex));
        markers.set(p.hex, m);
        toAdd.push(m);
      } else {
        m.setIcon(icon(p));
      }
      m.plane = p;
      m.setZIndexOffset(p.hex === opts.selected ? 1000 : 0);

      // trail: remember real reported positions only
      const t = trails.get(p.hex) || [];
      const last = t[t.length - 1];
      if (!last || last[0] !== p.lat || last[1] !== p.lon) t.push([p.lat, p.lon]);
      if (t.length > 60) t.shift();
      trails.set(p.hex, t);
    }
    if (toAdd.length) cluster.addLayers(toAdd);
    for (const [hex, m] of markers) {
      if (!seen.has(hex)) {
        cluster.removeLayer(m);
        markers.delete(hex);
        trails.delete(hex);
        trailLines.get(hex)?.remove();
        trailLines.delete(hex);
      }
    }
    drawTrails();
    animate();
  }

  function drawTrails() {
    for (const [hex, line] of trailLines) if (!opts.trails || !markers.has(hex)) { line.remove(); trailLines.delete(hex); }
    if (!opts.trails) return;
    for (const p of planes) {
      const pts = trails.get(p.hex);
      if (!pts || pts.length < 2) continue;
      const style = { color: altColor(p.altitude).replace(/var\((--[\w-]+)\)/, (_, v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()), weight: p.hex === opts.selected ? 3 : 2, opacity: p.hex === opts.selected ? 0.9 : 0.45, interactive: false };
      const line = trailLines.get(p.hex);
      if (line) line.setLatLngs(pts).setStyle(style);
      else trailLines.set(p.hex, L.polyline(pts, style).addTo(trailLayer));
    }
  }

  // Glide every plane forward from its last report, once a second.
  function animate() {
    const now = Date.now();
    for (const m of markers.values()) {
      const p = m.plane;
      const [lat, lon] = deadReckon(p.lat, p.lon, p.heading, p.speed, (now - p.seenAt) / 1000);
      m.setLatLng([lat, lon]);
    }
    drawPrediction();
  }
  setInterval(() => { if (!document.hidden) animate(); }, 1000);

  // Dashed line: where the selected plane will be in 5 minutes if it keeps going.
  function drawPrediction() {
    const p = planes.find((x) => x.hex === opts.selected);
    if (!p || p.speed == null || p.heading == null) { prediction?.remove(); prediction = null; return; }
    const from = markers.get(p.hex)?.getLatLng();
    if (!from) return;
    const to = destination(from.lat, from.lng, p.heading, (p.speed * 300) / 1000);
    if (prediction) prediction.setLatLngs([from, to]);
    else prediction = L.polyline([from, to], { color: "#fff", weight: 2, dashArray: "4 6", opacity: 0.8, interactive: false }).addTo(map);
  }

  function setMe(lat, lon, radiusKm, fit) {
    if (!me) {
      me = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [18, 18] }), zIndexOffset: 2000, keyboard: false, interactive: false }).addTo(map);
      circle = L.circle([lat, lon], { radius: radiusKm * 1000, className: "range", interactive: false }).addTo(map);
    }
    me.setLatLng([lat, lon]);
    circle.setLatLng([lat, lon]).setRadius(radiusKm * 1000);
    if (fit) map.fitBounds(circle.getBounds(), { padding: [20, 20] });
  }

  function focus(p) {
    const m = markers.get(p.hex);
    if (!m) { map.panTo([p.lat, p.lon]); return; }
    // Zoom out of a cluster bubble if needed, then make sure it's on screen.
    cluster.zoomToShowLayer(m, () => map.panInside(m.getLatLng(), { padding: [60, 60] }));
  }

  return { map, setStyle, setPlanes, setMe, focus, invalidate: () => map.invalidateSize() };
}
