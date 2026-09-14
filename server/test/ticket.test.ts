import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { ALG, secretKey, verifyTicket } from '../src/ticket.ts';

const key = secretKey('test-secret');

// Same signing as web/app/ticket.ts, with a fixed clock
function mint(k: Uint8Array, expiresInS: number, now: Date, exp = true): Promise<string> {
  const jwt = new SignJWT({}).setProtectedHeader({ alg: ALG });
  if (exp) jwt.setExpirationTime(Math.floor(now.getTime() / 1000) + expiresInS);
  return jwt.sign(k);
}

test('ticket: signed with the shared secret and not expired', async () => {
  const now = new Date('2026-09-12T10:00:00Z');
  assert.equal(await verifyTicket(await mint(key, 50, now), key, now), true);
  assert.equal(await verifyTicket(await mint(key, 50, now), key, new Date(now.getTime() + 49_000)), true);
});

test('ticket: expired', async () => {
  const now = new Date('2026-09-12T10:00:00Z');
  const ticket = await mint(key, 50, now);
  assert.equal(await verifyTicket(ticket, key, new Date(now.getTime() + 51_000)), false);
});

test('ticket: signed with another secret, without exp, malformed or empty', async () => {
  const now = new Date('2026-09-12T10:00:00Z');
  assert.equal(await verifyTicket(await mint(secretKey('other'), 50, now), key, now), false);
  assert.equal(await verifyTicket(await mint(key, 50, now, false), key, now), false);
  assert.equal(await verifyTicket('not.a.jwt', key, now), false);
  assert.equal(await verifyTicket('', key, now), false);
});
