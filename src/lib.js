// Pure helpers for the Worker (no network), so they can be unit-tested.

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// Many visitors near each other should share one upstream request. So snap the
// search centre to a 0.05° grid (~5 km) and widen the radius to cover the snap,
// rounding it up to 5 nautical miles. The page filters exactly afterwards.
export function snapQuery(box) {
  const lat = (box.lamin + box.lamax) / 2;
  const lon = (box.lomin + box.lomax) / 2;
  const radiusKm = distanceKm(lat, lon, box.lamax, box.lomax);
  const sLat = Math.round(lat * 20) / 20;
  const sLon = Math.round(lon * 20) / 20;
  const extraKm = distanceKm(lat, lon, sLat, sLon);
  const nm = Math.min(250, Math.ceil((radiusKm + extraKm) / 1.852 / 5) * 5);
  return { lat: sLat, lon: sLon, nm, key: `${sLat.toFixed(2)},${sLon.toFixed(2)},${nm}` };
}

// Read and check the bounding box the page sends. Returns null if bad.
export function parseBox(params) {
  const box = {};
  for (const key of ["lamin", "lomin", "lamax", "lomax"]) {
    const raw = params.get(key);
    const value = Number(raw);
    if (raw === null || raw === "" || !Number.isFinite(value)) return null;
    box[key] = value;
  }
  if (box.lamin > box.lamax || Math.abs(box.lamin) > 90 || Math.abs(box.lamax) > 90) return null;
  return box;
}

// Convert one adsb.lol aircraft into an OpenSky state array (units: m, m/s).
// 0 icao24, 1 callsign, 2 country, 5 lon, 6 lat, 7 baro alt, 8 on ground,
// 9 speed, 10 heading, 11 vertical rate, 13 GPS alt, 14 squawk.
// Extras after OpenSky's 17 fields:
// 17 registration, 18 type code, 19 db flags (1 = military), 20 emitter category,
// 21 wind direction °, 22 wind speed kt, 23 outside air temp °C, 24 mach,
// 25 selected altitude (ft), 26 emergency ("none", "general", …)
export function toOpenSkyState(a) {
  const FT = 0.3048;
  const onGround = a.alt_baro === "ground";
  const baroAlt = typeof a.alt_baro === "number" ? a.alt_baro * FT : null;
  const gpsAlt = typeof a.alt_geom === "number" ? a.alt_geom * FT : null;
  const rateFtMin = a.baro_rate ?? a.geom_rate;
  return [
    a.hex,
    a.flight || "",
    countryFromIcao(a.hex),
    null, null,
    a.lon ?? null,
    a.lat ?? null,
    baroAlt,
    onGround,
    a.gs == null ? null : a.gs * 0.514444, // knots -> m/s
    a.track ?? a.true_heading ?? null,
    rateFtMin == null ? null : (rateFtMin * FT) / 60, // ft/min -> m/s
    null,
    gpsAlt,
    a.squawk ?? null,
    false, 0, // spi, position source (unused)
    a.r ?? null,
    a.t ?? null,
    a.dbFlags ?? 0,
    a.category ?? null,
    a.wd ?? null,
    a.ws ?? null,
    a.oat ?? null,
    a.mach ?? null,
    a.nav_altitude_mcp ?? a.nav_altitude_fms ?? null,
    a.emergency ?? null,
  ];
}

// Nicknames for the leaderboard: letters, numbers, spaces, _ and -, 2–20 chars.
export function cleanNick(nick) {
  const s = String(nick ?? "").normalize("NFKC").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 20);
  return s.length >= 2 ? s : null;
}

// Aircraft type codes: 2–4 letters/digits, e.g. "A388", "B77W".
export function cleanType(type) {
  const s = String(type ?? "").toUpperCase();
  return /^[A-Z0-9]{2,4}$/.test(s) ? s : null;
}

// Country of registration from the aircraft's ICAO 24-bit address, the same
// way OpenSky works out "origin country". Main blocks only; others are null.
// [first address, last address, country]
const ICAO_BLOCKS = [
  [0x008000, 0x00ffff, "South Africa"], [0x010000, 0x017fff, "Egypt"],
  [0x020000, 0x027fff, "Morocco"], [0x040000, 0x040fff, "Ethiopia"],
  [0x04c000, 0x04cfff, "Kenya"], [0x064000, 0x064fff, "Nigeria"],
  [0x06a000, 0x06a3ff, "Qatar"], [0x0ac000, 0x0acfff, "Colombia"],
  [0x0d0000, 0x0d7fff, "Mexico"], [0x100000, 0x1fffff, "Russia"],
  [0x300000, 0x33ffff, "Italy"], [0x340000, 0x37ffff, "Spain"],
  [0x380000, 0x3bffff, "France"], [0x3c0000, 0x3fffff, "Germany"],
  [0x400000, 0x43ffff, "United Kingdom"], [0x440000, 0x447fff, "Austria"],
  [0x448000, 0x44ffff, "Belgium"], [0x458000, 0x45ffff, "Denmark"],
  [0x460000, 0x467fff, "Finland"], [0x468000, 0x46ffff, "Greece"],
  [0x470000, 0x477fff, "Hungary"], [0x478000, 0x47ffff, "Norway"],
  [0x480000, 0x487fff, "Netherlands"], [0x488000, 0x48ffff, "Poland"],
  [0x490000, 0x497fff, "Portugal"], [0x498000, 0x49ffff, "Czechia"],
  [0x4a0000, 0x4a7fff, "Romania"], [0x4a8000, 0x4affff, "Sweden"],
  [0x4b0000, 0x4b7fff, "Switzerland"], [0x4b8000, 0x4bffff, "Turkey"],
  [0x4ca000, 0x4cafff, "Ireland"], [0x4cc000, 0x4ccfff, "Iceland"],
  [0x4d0000, 0x4d03ff, "Luxembourg"], [0x4d2000, 0x4d23ff, "Malta"],
  [0x508000, 0x50ffff, "Ukraine"], [0x683000, 0x6833ff, "Kazakhstan"],
  [0x702000, 0x702fff, "Bangladesh"], [0x706000, 0x706fff, "Kuwait"],
  [0x70c000, 0x70c3ff, "Oman"], [0x710000, 0x717fff, "Saudi Arabia"],
  [0x718000, 0x71ffff, "South Korea"], [0x730000, 0x737fff, "Iran"],
  [0x738000, 0x73ffff, "Israel"], [0x740000, 0x747fff, "Jordan"],
  [0x750000, 0x757fff, "Malaysia"], [0x758000, 0x75ffff, "Philippines"],
  [0x760000, 0x767fff, "Pakistan"], [0x768000, 0x76ffff, "Singapore"],
  [0x770000, 0x777fff, "Sri Lanka"], [0x780000, 0x7bffff, "China"],
  [0x7c0000, 0x7fffff, "Australia"], [0x800000, 0x83ffff, "India"],
  [0x840000, 0x87ffff, "Japan"], [0x880000, 0x887fff, "Thailand"],
  [0x888000, 0x88ffff, "Vietnam"], [0x896000, 0x896fff, "United Arab Emirates"],
  [0x899000, 0x8993ff, "Taiwan"], [0x8a0000, 0x8a7fff, "Indonesia"],
  [0xa00000, 0xafffff, "United States"], [0xc00000, 0xc3ffff, "Canada"],
  [0xc80000, 0xc87fff, "New Zealand"], [0xe00000, 0xe3ffff, "Argentina"],
  [0xe40000, 0xe7ffff, "Brazil"], [0xe80000, 0xe80fff, "Chile"],
  [0xe8c000, 0xe8cfff, "Peru"],
];

export function countryFromIcao(hex) {
  if (String(hex).startsWith("~")) return null; // "~" marks non-ICAO (TIS-B) addresses
  const n = parseInt(String(hex), 16);
  if (!Number.isFinite(n)) return null;
  const block = ICAO_BLOCKS.find(([lo, hi]) => n >= lo && n <= hi);
  return block ? block[2] : null;
}

// Cities with their own page (/over/<slug>), for sharing and search engines.
export const CITIES = {
  london: ["London", 51.4700, -0.4543], dubai: ["Dubai", 25.2528, 55.3644],
  colombo: ["Colombo", 7.1808, 79.8841], "new-york": ["New York", 40.6413, -73.7781],
  "los-angeles": ["Los Angeles", 33.9416, -118.4085], singapore: ["Singapore", 1.3644, 103.9915],
  tokyo: ["Tokyo", 35.5494, 139.7798], paris: ["Paris", 49.0097, 2.5479],
  frankfurt: ["Frankfurt", 50.0379, 8.5622], amsterdam: ["Amsterdam", 52.3105, 4.7683],
  istanbul: ["Istanbul", 41.2753, 28.7519], doha: ["Doha", 25.2731, 51.6081],
  delhi: ["Delhi", 28.5562, 77.1000], mumbai: ["Mumbai", 19.0896, 72.8656],
  "hong-kong": ["Hong Kong", 22.3080, 113.9185], sydney: ["Sydney", -33.9399, 151.1753],
  atlanta: ["Atlanta", 33.6407, -84.4277], chicago: ["Chicago", 41.9742, -87.9073],
  toronto: ["Toronto", 43.6777, -79.6248], madrid: ["Madrid", 40.4983, -3.5676],
  bangkok: ["Bangkok", 13.6900, 100.7501], "kuala-lumpur": ["Kuala Lumpur", 2.7456, 101.7072],
  seoul: ["Seoul", 37.4602, 126.4407], "sao-paulo": ["São Paulo", -23.4356, -46.4731],
  johannesburg: ["Johannesburg", -26.1367, 28.2411], cairo: ["Cairo", 30.1219, 31.4056],
  zurich: ["Zurich", 47.4582, 8.5555], munich: ["Munich", 48.3538, 11.7861],
  rome: ["Rome", 41.8003, 12.2389], beijing: ["Beijing", 40.0799, 116.6031],
};
