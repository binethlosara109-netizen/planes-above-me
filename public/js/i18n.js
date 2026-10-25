// Translations. English is built in; other languages load from js/lang/<code>.js
// when chosen. Missing words fall back to English.
// In HTML, data-i18n="key" sets text, data-i18n-ph="key" sets placeholder,
// data-i18n-label="key" sets aria-label and title.

export const LANGUAGES = {
  en: "English", si: "සිංහල", ta: "தமிழ்", ar: "العربية", es: "Español",
  fr: "Français", de: "Deutsch", zh: "中文", ja: "日本語",
};
const RTL = new Set(["ar"]);

const en = {
  appName: "Planes Above Me",
  tagline: "Live aircraft around you, anywhere in the world",
  finding: "Finding your location…",
  yourLocation: "Your location",
  searchPh: "Search a place, or type lat, lon",
  go: "Go",
  gps: "GPS",
  whatsFlying: "What's flying above you?",
  allowLoc: "Allow location access, or search for a place above.",
  foundYou: "Found you. Ready when you are.",
  showPlanes: "Show planes above me",
  lat: "Latitude", lon: "Longitude", alt: "Altitude", source: "Source",
  srcGps: "GPS", srcTyped: "Typed",
  usingGps: "Using your GPS (accuracy ±{m} m).",
  usingPlace: "Using {place}. Tap GPS to switch back.",
  gpsSlow: "GPS isn't responding. Type a place or coordinates (e.g. 6.93, 79.85) in the search box.",
  gpsFallback: "GPS isn't responding, so we're using your last place. Tap GPS to try again.",
  gpsBlocked: "Location is blocked. Search for a place above, or allow location in your browser settings.",
  gpsWaiting: "Waiting for GPS… You can also type a place above.",
  searching: "Searching for “{q}”…",
  notFound: "Couldn't find “{q}”. Try a city name, or coordinates like 6.93, 79.85.",
  live: "Live", refresh: "Refresh now", radius: "Search radius",
  aircraft: "Aircraft", closest: "Closest", highest: "Highest", fastest: "Fastest",
  tabFlights: "Flights", tabAirport: "Airport", tabSky: "Sky", tabMe: "My log",
  fAll: "All", fAirline: "Airlines", fPrivate: "Private", fMilitary: "Military", fRare: "Rare",
  fClimb: "Climbing", fDesc: "Descending",
  findPh: "Filter, or find any flight (e.g. EK5)",
  findWorld: "Searching the whole world for {q}…",
  findNone: "No flight {q} is in the air right now.",
  farAway: "{d} away from you",
  summary: "{n} aircraft within {r} · {when}",
  shown: "{n} shown",
  updated: "updated {t}",
  staleData: "data from {s} s ago (service busy)",
  noneTitle: "No aircraft within {r} right now",
  noneHint: "Try a bigger radius, or check back in a minute.",
  noMatch: "No aircraft match this filter.",
  scanning: "Scanning the sky…",
  busy: "The free flight data service is busy right now. It usually recovers within a minute.",
  offline: "You're offline. Results will update when you reconnect.",
  loadFail: "Couldn't load aircraft right now. Please try again.",
  climbing: "Climbing", descending: "Descending", level: "Level",
  ofYou: "{dir} of you",
  privateGA: "Private / general aviation",
  routeUnknown: "Route not known for this flight (common for private, cargo and military flights).",
  noCallsign: "This aircraft isn't sending a flight number.",
  flownToGo: "{a} flown · {b} to go",
  secLive: "Live", secAircraft: "Aircraft", secWeather: "Weather at the plane",
  speed: "Speed", heading: "Heading", vertical: "Vertical", fromYou: "From you", squawk: "Squawk",
  type: "Type", registration: "Registration", operator: "Operator", icao: "ICAO address",
  registeredIn: "Registered in {c}",
  wind: "Wind", outsideTemp: "Outside air", mach: "Mach", selectedAlt: "Cleared to", inView: "In the sky",
  elevationAt: "{e}° above the horizon, look {dir}",
  belowHorizon: "Below your horizon",
  leftArea: "This aircraft has left your search area.",
  noPhoto: "No photo of this aircraft yet", lookingPhoto: "Looking for a photo…",
  sawIt: "I saw it!", saved: "In your log ✓", share: "Share", liveTrack: "Live track",
  overhead: "{c} is right above you – look up!",
  watchHit: "On your watchlist: {c} is nearby",
  newPlane: "New: {c}",
  nearestAirport: "Nearest airport", frequencies: "ATC frequencies", listenLive: "Listen live on LiveATC",
  arriving: "Arriving", departing: "Departing", board: "Live board",
  nothingBoard: "No arrivals or departures with known routes in range right now.",
  spotting: "Spotting conditions", visibility: "Visibility", clouds: "Clouds", temp: "Temperature",
  good: "Great for spotting", fair: "OK for spotting", poor: "Poor visibility",
  skyTitle: "Sky view",
  skyHint: "Planes as you'd see them from the ground: the centre is straight up, the edge is the horizon.",
  arStart: "Look up (AR camera)", arHint: "Point your phone at the sky.",
  arUnsupported: "AR needs a phone with a compass and a camera.",
  arPermission: "Allow motion and camera access to use AR.",
  close: "Close",
  logTitle: "My spotting log",
  logEmpty: "Tap “I saw it!” on any aircraft to start your collection.",
  spotted: "Spotted", types: "Types", airlines: "Airlines", countries: "Countries",
  recent: "Recently spotted",
  leaderboard: "Leaderboard", joinBoard: "Join the leaderboard with your aircraft types",
  nickPh: "Your nickname", join: "Join", joined: "You're on the leaderboard as {n}.",
  statsLink: "Site stats", privacyLink: "Privacy",
  settings: "Settings", language: "Language", units: "Units",
  unitsMetric: "Metric (km, m, km/h)", unitsImperial: "Imperial (mi, ft, mph)", unitsAviation: "Aviation (NM, ft, kt)",
  clock: "Clock", clock24: "24-hour", clock12: "12-hour",
  theme: "Theme", themeDark: "Dark", themeLight: "Light", themeAuto: "Match my device",
  contrast: "High contrast", lite: "Lite mode (saves data: no photos, slower refresh)",
  sound: "Sound when a new plane appears", mapStyle: "Map",
  mapDark: "Dark", mapSat: "Satellite", mapLight: "Light",
  trails: "Flight trails", labels: "Callsign labels on the map", radiusDefault: "Default radius",
  alerts: "Alerts", watchlist: "Watchlist: flights, airlines or aircraft types",
  watchPh: "e.g. EK5, QTR, A388",
  notify: "Phone notifications while the site is open", overheadAlert: "Alert when a plane is right above me",
  installApp: "Install app", done: "Done",
  rare: "Rare", military: "Military", emergency: "Emergency", newType: "New for you",
  shareText: "{c} just flew over {p}! Spotted with Planes Above Me",
  shareHere: "Live planes over {p}",
  linkCopied: "Link copied",
  copyLink: "Copy link",
  nearbyCities: "Planes over",
  announce: "{n} aircraft nearby. Closest: {c}, {d}.",
};

export const EN = en;
let strings = en;
let current = "en";

export const lang = () => current;
export const isRtl = () => RTL.has(current);

// t("summary", { n: 3 }) -> "3 aircraft …"
export function t(key, vars = {}) {
  const s = strings[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
}

export async function setLanguage(code) {
  if (!LANGUAGES[code]) code = "en";
  strings = code === "en" ? en : { ...en, ...(await import(`./lang/${code}.js`)).default };
  current = code;
  document.documentElement.lang = code;
  document.documentElement.dir = RTL.has(code) ? "rtl" : "ltr";
  translatePage();
}

export function translatePage(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll("[data-i18n-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nLabel));
    el.title = t(el.dataset.i18nLabel);
  });
}

// Best guess from the browser's languages, e.g. "si-LK" -> "si".
export function guessLanguage() {
  for (const l of navigator.languages || [navigator.language]) {
    const code = String(l).slice(0, 2).toLowerCase();
    if (LANGUAGES[code]) return code;
  }
  return "en";
}
