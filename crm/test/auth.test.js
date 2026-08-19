import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { hashPassword, verifyPassword, createSession, getSession } from '../lib/auth.js';

describe('hashPassword / verifyPassword', () => {
  it('verifies a correct password against its hash', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
  });
});

describe('createSession / getSession', () => {
  it('creates a session that resolves back to the staff account', async () => {
    await env.DB.prepare(
      `INSERT INTO staff_accounts (id, username, password_hash, role, created_at)
       VALUES (1, 'le_tan_a', 'x', 'reception', '2026-08-01T00:00:00Z')`
    ).run();

    const token = await createSession(env.DB, 1);
    const session = await getSession(env.DB, token);
    expect(session).toEqual({ staffId: 1, username: 'le_tan_a', role: 'reception' });
  });

  it('returns null for an unknown token', async () => {
    expect(await getSession(env.DB, 'does-not-exist')).toBeNull();
  });
});
