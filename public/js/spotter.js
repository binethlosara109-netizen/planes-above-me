// Spotter features: rare aircraft, the spotting log, sounds and alerts.

// Aircraft types worth a "Rare" badge (ICAO type code -> name).
export const RARE_TYPES = {
  A388: "Airbus A380", B741: "Boeing 747-100", B742: "Boeing 747-200", B743: "Boeing 747-300",
  B744: "Boeing 747-400", B748: "Boeing 747-8", B74S: "Boeing 747SP", BLCF: "Boeing 747 Dreamlifter",
  A3ST: "Airbus Beluga", A337: "Airbus BelugaXL", A124: "Antonov An-124", A225: "Antonov An-225",
  AN22: "Antonov An-22", IL76: "Ilyushin Il-76", IL96: "Ilyushin Il-96", MD11: "McDonnell Douglas MD-11",
  DC10: "McDonnell Douglas DC-10", L101: "Lockheed TriStar", CONC: "Concorde", A400: "Airbus A400M",
  C17: "Boeing C-17", C5M: "Lockheed C-5 Galaxy", C130: "Lockheed C-130 Hercules", C30J: "Lockheed C-130J",
  K35R: "Boeing KC-135", KC2: "Kawasaki C-2", E3TF: "Boeing E-3 AWACS", E3CF: "Boeing E-3 AWACS",
  B52: "Boeing B-52", U2: "Lockheed U-2", B2: "Northrop B-2", V22: "Bell Boeing V-22 Osprey",
  DC3: "Douglas DC-3", DC6: "Douglas DC-6", JU52: "Junkers Ju 52", SPIT: "Supermarine Spitfire",
  P51: "P-51 Mustang", B17: "Boeing B-17", L049: "Lockheed Constellation", A342: "Airbus A340-200",
  A343: "Airbus A340-300", A345: "Airbus A340-500", A346: "Airbus A340-600", B762: "Boeing 767-200",
};

export const EMERGENCY_SQUAWKS = { "7500": "Hijack", "7600": "Radio failure", "7700": "Emergency" };

// Badges for a plane: rare / military / emergency / new for you.
export function badges(p, log) {
  const out = [];
  if (p.emergency) out.push({ kind: "emergency", key: "emergency" });
  if (p.military) out.push({ kind: "military", key: "military" });
  if (p.typeCode && RARE_TYPES[p.typeCode]) out.push({ kind: "rare", key: "rare" });
  if (p.typeCode && log && !log.types.has(p.typeCode) && log.entries.length) out.push({ kind: "new", key: "newType" });
  return out;
}

// ---------- Spotting log (stored in this browser) ----------

const LOG_KEY = "planes.log.v1";

export function loadLog() {
  let entries = [];
  try { entries = JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch {}
  return summarise(entries);
}

function summarise(entries) {
  return {
    entries,
    types: new Set(entries.map((e) => e.type).filter(Boolean)),
    airlines: new Set(entries.map((e) => e.airline).filter(Boolean)),
    countries: new Set(entries.map((e) => e.country).filter(Boolean)),
    hexes: new Set(entries.map((e) => e.hex)),
  };
}

// Add a sighting (once per aircraft per day). Returns the updated log.
export function addToLog(entry) {
  const log = loadLog();
  const today = new Date().toISOString().slice(0, 10);
  const dup = log.entries.some((e) => e.hex === entry.hex && e.ts.slice(0, 10) === today);
  if (!dup) {
    log.entries.unshift({ ...entry, ts: new Date().toISOString() });
    log.entries.length = Math.min(log.entries.length, 2000);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(log.entries)); } catch {}
  }
  return summarise(log.entries);
}

// ---------- Sound ----------

let audio = null;
// A soft two-note "ping" made in the browser (no sound files needed).
export function ping(high = false) {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = audio.currentTime;
    [0, 0.12].forEach((delay, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = (high ? 880 : 660) * (i ? 1.5 : 1);
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.15, now + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.4);
    });
  } catch {}
}

// ---------- Notifications (only while the site is open) ----------

export async function askNotifications() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

export function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
      new Notification(title, { body, icon: "/icons/icon-192.png", tag: "planes-" + title });
    }
  } catch {}
}

// Does a plane match the watchlist? Items can be a callsign (EK5 / UAE5),
// an airline ICAO code (QTR), a type code (A388) or a registration.
export function matchesWatch(p, items, info) {
  if (!items.length) return null;
  const candidates = [p.callsign, p.typeCode, p.registration, p.callsign.slice(0, 3),
    info?.route?.callsign_iata, info?.airline?.iata].filter(Boolean).map((s) => s.toUpperCase());
  return items.find((w) => candidates.includes(w)) || null;
}
