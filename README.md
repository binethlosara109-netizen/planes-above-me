# ✈️ Planes Above Me

A small hobby website that shows which aircraft are flying near you right now, anywhere in the world.

**Live site:** https://binethlosara109-netizen.github.io/planes-above-me/

## How it works

- `index.html`, `style.css`, `app.js` – the whole website (no build step). Hosted on GitHub Pages.
- The page reads your location from the browser, draws a box around you, asks the relay for
  aircraft in that box, then keeps only the ones inside the chosen circle (10 / 25 / 50 km,
  haversine distance), skipping planes on the ground.
- `relay/worker.js` – a tiny Cloudflare Worker. It's needed because OpenSky blocks requests
  from other websites (CORS) and from Cloudflare's servers. The relay fetches live data from
  [adsb.lol](https://adsb.lol) (backup: [adsb.fi](https://adsb.fi)) and returns it in the
  OpenSky `states` format.

## Updating

- Website: edit the files and push to `main`; GitHub Pages republishes in about a minute.
- Relay: edit `relay/worker.js`, then from the `relay` folder run `npx wrangler deploy`.
