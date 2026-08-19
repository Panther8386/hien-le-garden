import { verifyPassword, createSession } from '../../../lib/auth.js';

export async function onRequestPost({ request, env }) {
  const { username, password } = await request.json();

  const account = await env.DB.prepare(
    `SELECT id, password_hash, role FROM staff_accounts WHERE username = ?`
  )
    .bind(username)
    .first();

  if (!account || !(await verifyPassword(password, account.password_hash))) {
    return new Response(JSON.stringify({ error: 'Sai tài khoản hoặc mật khẩu' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = await createSession(env.DB, account.id);

  return new Response(JSON.stringify({ username, role: account.role }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`,
    },
  });
}
