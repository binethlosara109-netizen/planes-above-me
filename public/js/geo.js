// Geometry helpers (no browser APIs, so they're unit-tested in test/geo.test.js).

export const EARTH_RADIUS_KM = 6371;
export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;

// Great-circle distance in km (haversine formula).
export function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Compass direction (0–360°) from point 1 to point 2.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// A box around a point that fully contains the circle of radiusKm.
export function boundingBox(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(Math.cos(toRad(lat)), 0.01));
  return {
    lamin: Math.max(lat - dLat, -90), lamax: Math.min(lat + dLat, 90),
    lomin: Math.max(lon - dLon, -180), lomax: Math.min(lon + dLon, 180),
  };
}

// Where something will be after travelling distanceKm on a heading.
export function destination(lat, lon, headingDeg, distanceKm) {
  const d = distanceKm / EARTH_RADIUS_KM;
  const h = toRad(headingDeg);
  const la1 = toRad(lat), lo1 = toRad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(h));
  const lo2 = lo1 + Math.atan2(Math.sin(h) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [toDeg(la2), ((toDeg(lo2) + 540) % 360) - 180];
}

// Where a plane is now, guessed from its last report (speed m/s, heading °),
// so markers glide smoothly between updates. Capped at 30 s of guessing.
export function deadReckon(lat, lon, headingDeg, speedMs, seconds) {
  if (speedMs == null || headingDeg == null || seconds <= 0) return [lat, lon];
  return destination(lat, lon, headingDeg, (speedMs * Math.min(seconds, 30)) / 1000);
}

// How high above the horizon a plane appears from the ground (degrees),
// allowing for the Earth's curve.
export function elevationDeg(groundKm, planeAltM, observerAltM = 0) {
  const dropM = ((groundKm * 1000) ** 2) / (2 * EARTH_RADIUS_KM * 1000);
  return toDeg(Math.atan2((planeAltM ?? 0) - (observerAltM ?? 0) - dropM, Math.max(groundKm * 1000, 1)));
}

export const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg % 360) + 360) % 360 / 45) % 8];

// "lat, lon" typed by hand? Returns { lat, lon } or null.
export function parseCoordinates(text) {
  const m = String(text).trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

// Nearest item from a list of [.., .., .., .., .., lat, lon] rows (airports.json format).
export function nearestAirport(airports, lat, lon) {
  let best = null, bestKm = Infinity;
  for (const a of airports) {
    const km = distanceKm(lat, lon, a[5], a[6]);
    if (km < bestKm) { best = a; bestKm = km; }
  }
  return best ? { airport: best, km: bestKm } : null;
}
