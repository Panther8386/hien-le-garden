import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { onRequestPost as logout } from '../functions/api/auth/logout.js';
import { hashPassword } from '../lib/auth.js';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  const hash = await hashPassword('s3cret-pass');
  await env.DB.prepare(
    `INSERT INTO staff_accounts (id, username, password_hash, role, created_at)
     VALUES (1, 'quan_ly_a', ?, 'manager', '2026-08-01T00:00:00Z')`
  ).bind(hash).run();
});

describe('POST /api/auth/login', () => {
  it('sets a session cookie and returns the role on correct credentials', async () => {
    const request = new Request('https://crm.hienlegarden.vn/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'quan_ly_a', password: 's3cret-pass' }),
    });
    const response = await login({ request, env });

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toMatch(/^session=/);
    expect(await response.json()).toEqual({ username: 'quan_ly_a', role: 'manager' });
  });

  it('returns 401 on wrong password', async () => {
    const request = new Request('https://crm.hienlegarden.vn/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'quan_ly_a', password: 'wrong' }),
    });
    const response = await login({ request, env });
    expect(response.status).toBe(401);
  });

  it('rejects a malformed JSON body with 400 instead of crashing', async () => {
    const request = new Request('https://crm.hienlegarden.vn/api/auth/login', {
      method: 'POST',
      body: 'not json',
    });
    const response = await login({ request, env });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the session from the database', async () => {
    // First, log in to create a session
    const loginRequest = new Request('https://crm.hienlegarden.vn/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'quan_ly_a', password: 's3cret-pass' }),
    });
    const loginResponse = await login({ request: loginRequest, env });
    const setCookie = loginResponse.headers.get('Set-Cookie');
    const sessionToken = setCookie.match(/session=([^;]+)/)[1];

    // Verify the session exists in the database
    const sessionBefore = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?')
      .bind(sessionToken)
      .first();
    expect(sessionBefore).toBeDefined();

    // Now log out with the session cookie
    const logoutRequest = new Request('https://crm.hienlegarden.vn/api/auth/logout', {
      method: 'POST',
      headers: { 'Cookie': `session=${sessionToken}` },
    });
    const logoutResponse = await logout({ request: logoutRequest, env });

    // Verify logout returned 204
    expect(logoutResponse.status).toBe(204);

    // Verify the session was deleted from the database
    const sessionAfter = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?')
      .bind(sessionToken)
      .first();
    expect(sessionAfter).toBeNull();
  });
});
