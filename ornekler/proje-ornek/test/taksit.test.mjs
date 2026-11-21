import assert from "node:assert/strict";
import { test } from "node:test";
import { taksitPlani } from "../src/taksit.mjs";
import { vadeTarihleri } from "../src/vade.mjs";

test("tam bölünen tutar eşit taksitlere ayrılır", () => {
  assert.deepEqual(taksitPlani(9000, 3), [3000, 3000, 3000]);
});

test("tek taksit tutarın kendisidir", () => {
  assert.deepEqual(taksitPlani(12345, 1), [12345]);
});

test("geçersiz tutar ve taksit sayısı reddedilir", () => {
  assert.throws(() => taksitPlani(0, 3), RangeError);
  assert.throws(() => taksitPlani(9000, 0), RangeError);
  assert.throws(() => taksitPlani(9000, 37), RangeError);
});

test("vade tarihleri ay sonunu taşırmaz", () => {
  assert.deepEqual(vadeTarihleri("2026-01-31", 3), ["2026-01-31", "2026-02-28", "2026-03-31"]);
});
