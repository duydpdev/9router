import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import {
  normalizePasswordForStorage,
  verifyPasswordAgainstHash,
} from "../src/lib/password.js";

test("normalizes visually identical unicode passwords before storage", () => {
  const nfcPassword = "mậtkhẩu";
  const nfdPassword = nfcPassword.normalize("NFD");

  assert.notEqual(nfcPassword, nfdPassword);
  assert.equal(
    normalizePasswordForStorage(nfcPassword),
    normalizePasswordForStorage(nfdPassword)
  );
});

test("verifies a stored hash across NFC and NFD unicode forms", async () => {
  const nfcPassword = "mậtkhẩu";
  const nfdPassword = nfcPassword.normalize("NFD");
  const hash = await bcrypt.hash(normalizePasswordForStorage(nfdPassword), 10);

  assert.equal(await verifyPasswordAgainstHash(nfcPassword, hash), true);
  assert.equal(await verifyPasswordAgainstHash(nfdPassword, hash), true);
});

test("accepts legacy hashes created from decomposed unicode passwords", async () => {
  const nfcPassword = "mậtkhẩu";
  const nfdPassword = nfcPassword.normalize("NFD");
  const legacyHash = await bcrypt.hash(nfdPassword, 10);

  assert.equal(await verifyPasswordAgainstHash(nfcPassword, legacyHash), true);
  assert.equal(await verifyPasswordAgainstHash(nfdPassword, legacyHash), true);
});
