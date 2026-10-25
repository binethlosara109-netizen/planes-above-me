import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distanceKm, bearingDeg, boundingBox, destination, deadReckon, elevationDeg,
  compass, parseCoordinates, nearestAirport,
} from "../public/js/geo.js";
import { makeFormat } from "../public/js/format.js";

test("bearing: due east and due north", () => {
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 0.01);
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0) - 0) < 0.01);
});

test("bounding box contains the whole circle", () => {
  const b = boundingBox(51.47, -0.45, 50);
  assert.ok(distanceKm(51.47, -0.45, b.lamax, -0.45) >= 49.9);
  assert.ok(distanceKm(51.47, -0.45, 51.47, b.lomax) >= 49.9);
});

test("bounding box near the pole stays valid", () => {
  const b = boundingBox(89.9, 0, 50);
  assert.ok(b.lamax <= 90 && b.lomin >= -180 && b.lomax <= 180);
});

test("destination and back gives the same distance", () => {
  const [lat, lon] = destination(51.47, -0.45, 45, 100);
  assert.ok(Math.abs(distanceKm(51.47, -0.45, lat, lon) - 100) < 0.01);
});

test("dead reckoning moves 2.5 km in 10 s at 250 m/s and caps at 30 s", () => {
  const [a, b] = deadReckon(0, 0, 90, 250, 10);
  assert.ok(Math.abs(distanceKm(0, 0, a, b) - 2.5) < 0.01);
  const [c, d] = deadReckon(0, 0, 90, 250, 999);
  assert.ok(Math.abs(distanceKm(0, 0, c, d) - 7.5) < 0.01);
  assert.deepEqual(deadReckon(1, 2, null, 250, 10), [1, 2]);
});

test("elevation: straight up is ~90°, far away is low", () => {
  assert.ok(elevationDeg(0, 10000) > 89);
  assert.ok(Math.abs(elevationDeg(10, 10000) - 45) < 1);
  assert.ok(elevationDeg(400, 10000) < 0); // below the horizon thanks to the Earth's curve (~357 km)
});

test("compass words", () => {
  assert.equal(compass(0), "N");
  assert.equal(compass(359), "N");
  assert.equal(compass(46), "NE");
  assert.equal(compass(225), "SW");
});

test("coordinates typed by hand", () => {
  assert.deepEqual(parseCoordinates("6.93, 79.85"), { lat: 6.93, lon: 79.85 });
  assert.deepEqual(parseCoordinates("-33.9 151.17"), { lat: -33.9, lon: 151.17 });
  assert.equal(parseCoordinates("Colombo"), null);
  assert.equal(parseCoordinates("95, 10"), null);
});

test("nearest airport", () => {
  const list = [["EGLL", "LHR", "", "", "GB", 51.47, -0.46, []], ["OMDB", "DXB", "", "", "AE", 25.25, 55.37, []]];
  assert.equal(nearestAirport(list, 51.5, -0.4).airport[1], "LHR");
  assert.equal(nearestAirport([], 0, 0), null);
});

test("units", () => {
  const metric = makeFormat({ units: "metric", locale: "en" });
  const air = makeFormat({ units: "aviation", locale: "en" });
  const imp = makeFormat({ units: "imperial", locale: "en" });
  assert.equal(metric.alt(1000), "1,000 m");
  assert.equal(air.alt(1000), "3,281 ft");
  assert.equal(metric.speed(100), "360 km/h");
  assert.equal(air.speed(100), "194 kt");
  assert.equal(imp.speed(100), "224 mph");
  assert.equal(air.dist(18.52), "10.0 NM");
  assert.equal(metric.altShort(10668), "10.7 km");
  assert.equal(air.altShort(10668), "35.0k ft");
  assert.equal(metric.alt(null), "–");
});
