import { test } from "node:test";
import assert from "node:assert/strict";
import { distanceKm, snapQuery, parseBox, toOpenSkyState, countryFromIcao, cleanNick, cleanType, CITIES } from "../src/lib.js";

test("distance London Heathrow → Dubai is about 5,480 km", () => {
  const d = distanceKm(51.4700, -0.4543, 25.2528, 55.3644);
  assert.ok(d > 5400 && d < 5550, `got ${d}`);
});

test("snapQuery covers the requested circle and shares keys between neighbours", () => {
  const box = { lamin: 51.02, lomin: -1.17, lamax: 51.92, lomax: 0.27 };
  const a = snapQuery(box);
  const b = snapQuery({ lamin: 51.015, lomin: -1.16, lamax: 51.915, lomax: 0.28 });
  assert.equal(a.key, b.key);
  assert.equal(a.nm % 5, 0);
  assert.ok(a.nm * 1.852 >= distanceKm(51.47, -0.45, 51.92, 0.27), "radius covers the box corner");
  assert.ok(a.nm <= 250);
});

test("parseBox rejects missing or broken numbers", () => {
  assert.equal(parseBox(new URLSearchParams("lamin=1&lomin=2&lamax=3")), null);
  assert.equal(parseBox(new URLSearchParams("lamin=x&lomin=2&lamax=3&lomax=4")), null);
  assert.equal(parseBox(new URLSearchParams("lamin=5&lomin=2&lamax=3&lomax=4")), null);
  assert.deepEqual(parseBox(new URLSearchParams("lamin=1&lomin=2&lamax=3&lomax=4")), { lamin: 1, lomin: 2, lamax: 3, lomax: 4 });
});

test("toOpenSkyState converts units and keeps extras", () => {
  const s = toOpenSkyState({ hex: "896181", flight: "UAE5  ", lat: 51, lon: 0, alt_baro: 10000, alt_geom: 10100,
    gs: 400, track: 90, baro_rate: -1000, squawk: "7700", r: "A6-EEB", t: "A388", dbFlags: 1, ws: 50, wd: 270, oat: -40 });
  assert.equal(s[0], "896181");
  assert.equal(s[2], "United Arab Emirates");
  assert.ok(Math.abs(s[7] - 3048) < 0.1); // 10,000 ft in m
  assert.ok(Math.abs(s[9] - 205.78) < 0.1); // 400 kt in m/s
  assert.ok(Math.abs(s[11] - -5.08) < 0.01); // -1000 ft/min in m/s
  assert.equal(s[8], false);
  assert.equal(s[14], "7700");
  assert.equal(s[17], "A6-EEB");
  assert.equal(s[18], "A388");
  assert.equal(s[19], 1);
  assert.equal(s[21], 270);
  assert.equal(s[22], 50);
  assert.equal(toOpenSkyState({ hex: "abc", alt_baro: "ground" })[8], true);
});

test("countryFromIcao knows the main blocks", () => {
  assert.equal(countryFromIcao("40697b"), "United Kingdom");
  assert.equal(countryFromIcao("770001"), "Sri Lanka");
  assert.equal(countryFromIcao("a12345"), "United States");
  assert.equal(countryFromIcao("~123456"), null);
  assert.equal(countryFromIcao("zzz"), null);
});

test("nicknames and type codes are cleaned", () => {
  assert.equal(cleanNick("  Plane_Fan-99  "), "Plane_Fan-99");
  assert.equal(cleanNick("<script>"), "script");
  assert.equal(cleanNick("x"), null);
  assert.equal(cleanNick("a".repeat(40)).length, 20);
  assert.equal(cleanType("a388"), "A388");
  assert.equal(cleanType("A380-800"), null);
});

test("every city has a name and valid coordinates", () => {
  for (const [slug, [name, lat, lon]] of Object.entries(CITIES)) {
    assert.match(slug, /^[a-z-]+$/);
    assert.ok(name && Math.abs(lat) <= 90 && Math.abs(lon) <= 180, slug);
  }
});
