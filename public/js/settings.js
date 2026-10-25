// User settings, remembered in this browser only (localStorage).

const KEY = "planes.settings.v1";

export const DEFAULTS = {
  lang: null, // null = guess from the browser
  units: "metric", // metric | imperial | aviation
  clock: "24", // 24 | 12
  theme: "dark", // dark | light | auto
  contrast: false,
  lite: false,
  sound: false,
  mapStyle: "dark", // dark | satellite | light
  trails: true,
  labels: true,
  radius: 50, // 10 | 25 | 50
  watchlist: "", // "EK5, QTR, A388"
  notify: false,
  overheadAlert: true,
  nick: "",
};

let current = { ...DEFAULTS };
try { current = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch {}

export const settings = () => current;

export function saveSettings(changes) {
  current = { ...current, ...changes };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch {}
  applyLook();
  return current;
}

// Theme, contrast and lite mode are CSS classes on <html>.
export function applyLook() {
  const root = document.documentElement;
  const dark = current.theme === "auto"
    ? !window.matchMedia("(prefers-color-scheme: light)").matches
    : current.theme !== "light";
  root.dataset.theme = dark ? "dark" : "light";
  root.classList.toggle("contrast", !!current.contrast);
  root.classList.toggle("lite", !!current.lite);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#070b16" : "#f3f6fc");
}

window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
  if (current.theme === "auto") applyLook();
});

// Watchlist "EK5, qtr , a388" -> ["EK5", "QTR", "A388"]
export const watchItems = () =>
  current.watchlist.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
