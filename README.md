# ✈️ Planes Above Me

See the aircraft flying above you right now, anywhere in the world: a live map, the airline,
the route, a photo of the actual plane, and what's arriving at your nearest airport.
Free, no sign-up, works on phones and desktops, installable as an app.

**Live site:** https://planes-above-me.binethwise.workers.dev

## Features

- **Live map** with smooth plane movement, flight trails, a 5-minute prediction line,
  clustering near busy airports, and dark / light / satellite maps.
- **Details for every plane:** airline and logo, flight number, route with progress,
  photo, type, registration, operator, altitude, speed, wind and temperature at the plane,
  squawk code (emergencies are flagged).
- **Airport tab:** nearest airport, ATC frequencies, LiveATC link, live arrivals/departures
  board, spotting weather.
- **Sky view & AR:** see planes as they appear in the sky; point your phone up to label them.
- **Spotter tools:** "right above you" alerts, rare / military badges, watchlist alerts,
  sounds, a personal spotting log and a leaderboard.
- **Find any flight** worldwide from the search box; filters for airlines, private,
  military, rare, climbing, descending.
- **Sharing:** picture cards and links to a place or a plane; city pages like `/over/london`.
- **9 languages** (English, Sinhala, Tamil, Arabic, Spanish, French, German, Chinese,
  Japanese), metric / imperial / aviation units, 12/24-hour clock, high contrast,
  lite mode, screen-reader friendly.
- **Location:** GPS, or type a place / coordinates; falls back to your last place.
- **Public stats page** (`/stats.html`) and a privacy page (`/privacy.html`).

## How it works

The code lives here on GitHub and **Cloudflare deploys it automatically on every push to
`main`** (Workers Builds). Before each deploy `npm test` runs; if a test fails, nothing is
published.

- `public/` – the website (plain HTML/CSS/JS modules in `public/js/`, no build step).
- `src/worker.js` – the Cloudflare Worker: `/api/states` (aircraft near a place, cached for
  8 s and shared between nearby visitors, rate-limited per visitor), `/api/find`,
  `/api/stats`, `/api/visit`, `/api/log` (browser error reports), `/api/spot`
  (leaderboard), and `/over/<city>` pages. Pure helpers are in `src/lib.js`.
- `migrations/` – the Cloudflare D1 database (free tier) for stats, leaderboard and errors.
- `test/` – unit tests (`npm test`, Node's built-in test runner).
- `scripts/build-airports.py` – rebuilds `public/data/airports.json` from OurAirports.

OpenSky blocks requests from other websites and from Cloudflare, so live positions come
from [adsb.lol](https://adsb.lol) and are returned in the OpenSky `states` format.

Data sources (all free, no keys): positions [adsb.lol](https://adsb.lol) (ODbL);
airline, route, aircraft [adsbdb](https://www.adsbdb.com); photos
[planespotters.net](https://www.planespotters.net); airports and frequencies
[OurAirports](https://ourairports.com) (public domain); weather
[Open-Meteo](https://open-meteo.com); places [OpenStreetMap Nominatim](https://nominatim.org);
map tiles Esri; airline logos kiwi.com.

## Updating

Edit the files and push to `main`. Cloudflare tests, builds and publishes in about a minute.
Database changes: add a file to `migrations/` and run
`npx wrangler d1 migrations apply planes-above-me --remote`.
