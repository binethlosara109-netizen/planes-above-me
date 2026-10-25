import { test } from "node:test";
import assert from "node:assert/strict";
import { EN, LANGUAGES } from "../public/js/i18n.js";

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

for (const code of Object.keys(LANGUAGES).filter((c) => c !== "en")) {
  test(`${code}: every English word is translated, with the same {placeholders}`, async () => {
    const { default: tr } = await import(`../public/js/lang/${code}.js`);
    const missing = Object.keys(EN).filter((k) => !(k in tr));
    assert.deepEqual(missing, [], `missing in ${code}`);
    const extra = Object.keys(tr).filter((k) => !(k in EN));
    assert.deepEqual(extra, [], `unknown keys in ${code}`);
    for (const k of Object.keys(EN)) {
      assert.equal(placeholders(tr[k]), placeholders(EN[k]), `${code}.${k} placeholders`);
    }
  });
}
