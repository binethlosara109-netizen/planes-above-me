# ✈️ Planes Above Me

A small hobby website that shows which aircraft are flying near you right now, anywhere in the world.

**Live site:** https://planes-above-me.binethwise.workers.dev

## How it works

The code lives here on GitHub and **Cloudflare deploys it automatically on every push to `main`**
(Cloudflare Workers Builds, configured in `wrangler.toml`).

- `public/` – the website: `index.html`, `style.css`, `app.js` (no build step).
  The page reads your location, draws a box around you, asks `/api/states` for aircraft in it,
  then keeps only those inside the chosen circle (10 / 25 / 50 km, haversine distance),
  skipping planes on the ground.
- `src/worker.js` – the Cloudflare Worker behind `/api/states`. OpenSky blocks requests from
  other websites (CORS) and from Cloudflare, so it fetches live data from
  [adsb.lol](https://adsb.lol) (backup: [adsb.fi](https://adsb.fi)) and returns it in the
  OpenSky `states` format.

## Updating

Edit the files and push to `main`. Cloudflare rebuilds and publishes in about a minute.
