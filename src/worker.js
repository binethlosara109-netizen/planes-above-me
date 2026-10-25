// The Cloudflare Worker for Planes Above Me.
//
// - Website files (public/) are served by Cloudflare automatically.
// - /api/states returns aircraft near you, in OpenSky's "states" format.
//
// Why not call OpenSky directly? OpenSky does not let browsers on other sites
// read its answers (CORS), and it blocks requests from Cloudflare's servers.
// So this asks adsb.lol instead: free, no key, worldwide.
// (adsb.fi was tried as a backup, but it blocks all requests from Cloudflare.)
//
// Usage: GET /api/states?lamin=..&lomin=..&lamax=..&lomax=..

const ADSB_LOL = "https://api.adsb.lol/v2/point";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Anything that isn't the API is a website file (or "not found").
    if (url.pathname !== "/api/states") return env.ASSETS.fetch(request);

    // Read the bounding box the page sends.
    const params = url.searchParams;
    const box = {};
    for (const key of ["lamin", "lomin", "lamax", "lomax"]) {
      box[key] = Number(params.get(key));
      if (params.get(key) === null || !Number.isFinite(box[key])) {
        return json({ error: `missing or bad ${key}` }, 400);
      }
    }

    // adsb.lol searches a circle, so use the box's centre and the distance to
    // its corner (in nautical miles, max 250). The page filters exactly afterwards.
    const lat = (box.lamin + box.lamax) / 2;
    const lon = (box.lomin + box.lomax) / 2;
    const radiusNm = Math.min(Math.ceil(distanceKm(lat, lon, box.lamax, box.lomax) / 1.852), 250);

    // adsb.lol sometimes answers 429 "too many requests" for a moment,
    // so if the first try fails, wait 2 seconds and try once more.
    const source = `${ADSB_LOL}/${lat.toFixed(4)}/${lon.toFixed(4)}/${radiusNm}`;
    let lastStatus = 502;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) await new Promise((r) => setTimeout(r, 2000));
      try {
        const upstream = await fetch(source, { headers: { "User-Agent": "planes-above-me (hobby project)" } });
        if (!upstream.ok) { lastStatus = upstream.status; continue; }
        const data = await upstream.json();
        return json({ time: Math.floor(Date.now() / 1000), states: (data.ac || []).map(toOpenSkyState) });
      } catch (err) {
        lastStatus = 502;
      }
    }
    // Pass the status on (e.g. 429 rate limit) so the page can fall back / explain.
    return json({ error: "could not get flight data" }, lastStatus);
  },
};

// Convert one adsb.lol aircraft into an OpenSky state array (units: m, m/s).
// Index: 0 icao24, 1 callsign, 2 country, 5 lon, 6 lat, 7 baro alt, 8 on ground,
//        9 speed, 10 heading, 11 vertical rate, 13 GPS alt
function toOpenSkyState(a) {
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
  ];
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// Country of registration from the aircraft's ICAO 24-bit address, the same
// way OpenSky works out "origin country". Main blocks only; others are "unknown".
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

function countryFromIcao(hex) {
  const n = parseInt(String(hex).replace("~", ""), 16); // "~" marks non-ICAO (TIS-B) addresses
  if (String(hex).startsWith("~") || !Number.isFinite(n)) return null;
  const block = ICAO_BLOCKS.find(([lo, hi]) => n >= lo && n <= hi);
  return block ? block[2] : null;
}
