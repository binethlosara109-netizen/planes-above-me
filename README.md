# ✈️ Planes Above Me

A fun website that shows the aircraft flying around you right now, anywhere in the world:
a live dark map, the airline, the route (e.g. Dubai → London), a photo of the actual aircraft,
and live altitude, speed and heading.

**Live site:** https://planes-above-me.binethwise.workers.dev

- **Desktop / laptop:** everything on one screen (map left, flights right), no page scrolling.
- **Phone:** one scrolling page; tap a flight to slide up its details.
- **Location:** uses GPS, or type a place ("Colombo") or coordinates ("6.93, 79.85").

## How it works

The code lives here on GitHub and **Cloudflare deploys it automatically on every push to `main`**
(Cloudflare Workers Builds, configured in `wrangler.toml`).

- `public/` – the website (`index.html`, `style.css`, `app.js`), no build step.
- `src/worker.js` – the Cloudflare Worker behind `/api/states`. OpenSky blocks requests from
  other websites (CORS) and from Cloudflare, so it fetches live positions from
  [adsb.lol](https://adsb.lol) and returns them in the OpenSky `states` format.

Data sources (all free, no keys): positions from [adsb.lol](https://adsb.lol) (ODbL);
airline, route and aircraft details from [adsbdb](https://www.adsbdb.com); photos from
[planespotters.net](https://www.planespotters.net); airline logos from kiwi.com;
place search from [OpenStreetMap Nominatim](https://nominatim.org); map tiles from Esri.

## Updating

Edit the files and push to `main`. Cloudflare rebuilds and publishes in about a minute.
