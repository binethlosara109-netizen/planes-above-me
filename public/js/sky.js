// Sky view (a "looking up" chart) and the AR camera mode.
//
// Each plane's position in the sky = compass direction (azimuth) + height above
// the horizon (elevation), worked out from its distance and altitude.

import { elevationDeg, toRad, compass } from "./geo.js";
import { altColor, planeSvg } from "./mapview.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Add azimuth/elevation to each plane, as seen from the observer.
export function skyPositions(planes, observerAltM) {
  return planes.map((p) => ({ ...p, az: p.bearing, el: elevationDeg(p.distance, p.altitude, observerAltM) }));
}

// Polar chart: centre = straight up (90°), edge = horizon (0°), north at the top.
export function renderSkyView(svgHost, planes, observerAltM, { onSelect, selected }) {
  const R = 160, C = 180;
  const pts = skyPositions(planes, observerAltM).filter((p) => p.el > 0);
  const xy = (az, el) => {
    const r = R * (1 - el / 90);
    return [C + r * Math.sin(toRad(az)), C - r * Math.cos(toRad(az))];
  };
  const rings = [0, 30, 60].map((e) => `<circle cx="${C}" cy="${C}" r="${R * (1 - e / 90)}" class="sky-ring"/>`).join("");
  const ringLabels = [30, 60].map((e) => `<text x="${C + 4}" y="${C - R * (1 - e / 90) - 4}" class="sky-small">${e}°</text>`).join("");
  const cardinal = [["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(([n, az]) => {
    const [x, y] = xy(az, -9);
    return `<text x="${x}" y="${y}" class="sky-dir" text-anchor="middle" dominant-baseline="middle">${n}</text>`;
  }).join("");
  const dots = pts.map((p) => {
    const [x, y] = xy(p.az, p.el);
    return `<g class="sky-plane${p.hex === selected ? " selected" : ""}" data-hex="${esc(p.hex)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" style="--c:${altColor(p.altitude)}" tabindex="0" role="button" aria-label="${esc(p.callsign)}, ${Math.round(p.el)}° up, ${compass(p.az)}">
      <g transform="translate(-11 -11) scale(.92)">${planeSvg(p.heading).replace("<svg ", '<svg width="24" height="24" ')}</g>
      <text x="13" y="4" class="sky-label">${esc(p.callsign)}</text></g>`;
  }).join("");
  svgHost.innerHTML = `<svg viewBox="0 0 360 360" class="sky-svg" role="img">
    <circle cx="${C}" cy="${C}" r="${R}" class="sky-disc"/>${rings}
    <line x1="${C}" y1="${C - R}" x2="${C}" y2="${C + R}" class="sky-ring"/><line x1="${C - R}" y1="${C}" x2="${C + R}" y2="${C}" class="sky-ring"/>
    ${ringLabels}${cardinal}<circle cx="${C}" cy="${C}" r="3" class="sky-zenith"/>${dots}</svg>`;
  svgHost.querySelectorAll(".sky-plane").forEach((g) => {
    const pick = () => onSelect(g.dataset.hex);
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });
  return pts.length;
}

// ---------- AR camera ----------
//
// The camera shows the sky; labels are placed using the phone's compass heading
// and tilt. Field of view is an estimate for typical phone cameras (portrait).

const H_FOV = 50, V_FOV = 66;

export function createAR(host, { getPlanes, getObserverAlt, onClose, t }) {
  let stream = null, heading = null, pitch = 0, roll = 0, raf = 0, absolute = false;

  const video = host.querySelector("video");
  const layer = host.querySelector(".ar-labels");
  const status = host.querySelector(".ar-status");

  function onOrient(e) {
    // iPhone gives a true compass heading; Android gives alpha (absolute if supported).
    if (typeof e.webkitCompassHeading === "number") heading = e.webkitCompassHeading;
    else if (e.absolute || absolute) heading = (360 - e.alpha) % 360;
    else if (e.alpha != null && heading == null) heading = (360 - e.alpha) % 360;
    // beta 90 = phone upright facing the horizon; 180 = looking straight up
    pitch = (e.beta ?? 90) - 90;
    roll = e.gamma ?? 0;
  }

  function draw() {
    raf = requestAnimationFrame(draw);
    if (heading == null) { status.textContent = t("arHint"); return; }
    const w = host.clientWidth, h = host.clientHeight;
    const pts = skyPositions(getPlanes(), getObserverAlt());
    let html = "", visible = 0;
    for (const p of pts) {
      let dAz = ((p.az - heading + 540) % 360) - 180; // -180..180
      const dEl = p.el - pitch;
      if (Math.abs(dAz) > H_FOV / 2 + 5 || Math.abs(dEl) > V_FOV / 2 + 5 || p.el < -2) continue;
      // rotate by the phone's roll so labels stay level with the horizon
      const r = toRad(-roll);
      const x0 = (dAz / H_FOV) * w, y0 = (-dEl / V_FOV) * h;
      const x = w / 2 + x0 * Math.cos(r) - y0 * Math.sin(r);
      const y = h / 2 + x0 * Math.sin(r) + y0 * Math.cos(r);
      visible++;
      html += `<div class="ar-tag" style="transform:translate(${x.toFixed(0)}px,${y.toFixed(0)}px);--c:${altColor(p.altitude)}">
        <span class="ar-dot"></span><b>${esc(p.callsign)}</b><small>${esc(p.arLine || "")}</small></div>`;
    }
    layer.innerHTML = html;
    status.textContent = `${compass(heading)} ${Math.round(heading)}° · ${Math.round(pitch)}° · ${visible} ✈`;
  }

  async function start() {
    host.hidden = false;
    status.textContent = t("arHint");
    try {
      // iPhone needs explicit permission for motion sensors (must follow a tap).
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const ok = await DeviceOrientationEvent.requestPermission();
        if (ok !== "granted") throw new Error(t("arPermission"));
      }
      if ("ondeviceorientationabsolute" in window) {
        absolute = true;
        window.addEventListener("deviceorientationabsolute", onOrient);
      } else {
        window.addEventListener("deviceorientation", onOrient);
      }
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      video.srcObject = stream;
      await video.play().catch(() => {});
      draw();
    } catch (err) {
      status.textContent = err?.message && !/denied|NotAllowed/i.test(err.message) ? err.message : t("arUnsupported");
      draw();
    }
  }

  function stop() {
    cancelAnimationFrame(raf);
    window.removeEventListener("deviceorientationabsolute", onOrient);
    window.removeEventListener("deviceorientation", onOrient);
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
    heading = null;
    host.hidden = true;
    onClose?.();
  }

  host.querySelector(".ar-close").addEventListener("click", stop);
  return { start, stop };
}
