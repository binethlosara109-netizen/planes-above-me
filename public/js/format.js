// Number and unit formatting in the visitor's language and chosen units.
// units: "metric" (km, m, km/h) | "imperial" (mi, ft, mph) | "aviation" (NM, ft, kt)

const M_TO_FT = 3.28084;

export function makeFormat({ units = "metric", clock = "24", locale = "en" } = {}) {
  const num = (n, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);

  return {
    num,
    feet: (m) => Math.round(m * M_TO_FT),

    // Altitude in the main unit, e.g. "35,000 ft" or "10,668 m"
    alt(m) {
      if (m == null) return "–";
      return units === "metric" ? `${num(m)} m` : `${num(m * M_TO_FT)} ft`;
    },
    // Both, for the details view: "35,000 ft · 10,668 m"
    altBoth(m) {
      return m == null ? "–" : `${num(m * M_TO_FT)} ft · ${num(m)} m`;
    },
    // Compact for small boxes: "35.0k ft" / "10.7 km"
    altShort(m) {
      if (m == null) return "–";
      return units === "metric" ? `${num(m / 1000, 1)} km` : `${num((m * M_TO_FT) / 1000, 1)}k ft`;
    },
    speed(ms) {
      if (ms == null) return "–";
      if (units === "imperial") return `${num(ms * 2.23694)} mph`;
      if (units === "aviation") return `${num(ms * 1.94384)} kt`;
      return `${num(ms * 3.6)} km/h`;
    },
    speedBoth(ms) {
      return ms == null ? "–" : `${num(ms * 3.6)} km/h · ${num(ms * 1.94384)} kt`;
    },
    dist(km, digits = 1) {
      if (km == null) return "–";
      if (units === "imperial") return `${num(km * 0.621371, digits)} mi`;
      if (units === "aviation") return `${num(km / 1.852, digits)} NM`;
      return `${num(km, digits)} km`;
    },
    vrate(ms) {
      if (ms == null) return "";
      return units === "metric" ? `${num(Math.abs(ms))} m/s` : `${num(Math.abs(ms) * 196.85)} ft/min`;
    },
    temp: (c) => (c == null ? "–" : `${num(c)} °C`),
    time(date, seconds = true) {
      return new Intl.DateTimeFormat(locale, {
        hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined, hour12: clock === "12",
      }).format(date);
    },
    date(date) {
      return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(date);
    },
  };
}
