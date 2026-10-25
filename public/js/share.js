// Sharing: links that open the site at a place / on a plane, and a picture
// card ("look what just flew over me") drawn on a canvas.

// ?lat=..&lon=..&r=..&f=hex  -> opens there, optionally with that plane selected
export function shareUrl({ lat, lon, radius, hex }) {
  const u = new URL(location.origin + "/");
  u.searchParams.set("lat", lat.toFixed(4));
  u.searchParams.set("lon", lon.toFixed(4));
  if (radius) u.searchParams.set("r", radius);
  if (hex) u.searchParams.set("f", hex);
  return u.href;
}

export function readShareParams() {
  const q = new URLSearchParams(location.search);
  const lat = Number(q.get("lat")), lon = Number(q.get("lon"));
  if (!q.has("lat") || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const r = Number(q.get("r"));
  return { lat, lon, radius: [10, 25, 50].includes(r) ? r : null, hex: (q.get("f") || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6) || null };
}

// Share with the phone's share sheet, or copy the link on desktop.
export async function shareLink({ title, text, url }) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return "shared"; } catch (e) { if (e?.name === "AbortError") return "cancelled"; }
  }
  try { await navigator.clipboard.writeText(url); return "copied"; } catch { return "failed"; }
}

// Draw a 1080×1350 card (Instagram portrait size) and share or download it.
export async function shareCard({ photoUrl, callsign, airline, route, lines, place, url, text }) {
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");

  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0b1530"); bg.addColorStop(1, "#070b16");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  // Photo (only if the image server allows it to be used on a canvas)
  let photoH = 0;
  if (photoUrl) {
    const img = await loadImage(photoUrl).catch(() => null);
    if (img) {
      photoH = 640;
      const scale = Math.max(W / img.width, photoH / img.height);
      const w = img.width * scale, h = img.height * scale;
      g.drawImage(img, (W - w) / 2, (photoH - h) / 2, w, h);
      const fade = g.createLinearGradient(0, photoH - 220, 0, photoH);
      fade.addColorStop(0, "rgba(7,11,22,0)"); fade.addColorStop(1, "#0a1229");
      g.fillStyle = fade; g.fillRect(0, photoH - 220, W, 220);
    }
  }
  if (!photoH) {
    g.fillStyle = "rgba(124,240,212,.08)";
    g.beginPath(); g.arc(W / 2, 300, 220, 0, Math.PI * 2); g.fill();
    g.font = "220px system-ui"; g.textAlign = "center"; g.fillText("✈️", W / 2, 380);
    photoH = 560;
  }

  g.textAlign = "left";
  let y = photoH + 90;
  g.fillStyle = "#eef3ff";
  g.font = "800 96px 'JetBrains Mono', ui-monospace, monospace";
  g.fillText(callsign, 70, y);
  y += 64;
  if (airline) { g.font = "600 46px Inter, system-ui, sans-serif"; g.fillStyle = "#cfd9f5"; g.fillText(airline, 70, y); y += 70; }
  if (route) { g.font = "800 64px 'JetBrains Mono', ui-monospace, monospace"; g.fillStyle = "#7cf0d4"; g.fillText(route, 70, y); y += 80; }
  g.font = "500 40px Inter, system-ui, sans-serif"; g.fillStyle = "#8d9bbd";
  for (const line of lines) { g.fillText(line, 70, y); y += 58; }

  g.fillStyle = "rgba(77,163,255,.15)"; g.fillRect(0, H - 130, W, 130);
  g.fillStyle = "#eef3ff"; g.font = "700 40px Inter, system-ui, sans-serif";
  g.fillText("✈ Planes Above Me", 70, H - 55);
  g.textAlign = "right"; g.fillStyle = "#8d9bbd"; g.font = "500 34px Inter, system-ui, sans-serif";
  g.fillText(place || "", W - 70, H - 55);

  const blob = await new Promise((ok) => c.toBlob(ok, "image/png"));
  const file = new File([blob], `${callsign}-planes-above-me.png`, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text, url }); return "shared"; } catch (e) { if (e?.name === "AbortError") return "cancelled"; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return "downloaded";
}

function loadImage(src) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = src;
  });
}
