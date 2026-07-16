import test from 'node:test';
import assert from 'node:assert/strict';
import { openSecret, sealSecret } from '../crypto/secretBox.js';

test('sealSecret / openSecret round-trip', () => {
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'unit-test-session-secret';
  try {
    const plain = 'invite_abc123XYZ';
    const sealed = sealSecret(plain);
    assert.match(sealed, /^v1\./);
    assert.equal(openSecret(sealed), plain);
    assert.notEqual(sealSecret(plain), sealed); // random IV
  } finally {
    if (prev === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prev;
  }
});

test('sealSecret requires SESSION_SECRET', () => {
  const prev = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    assert.throws(() => sealSecret('x'), /SESSION_SECRET/);
  } finally {
    if (prev === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prev;
  }
});
