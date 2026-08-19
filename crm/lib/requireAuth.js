import { getSession } from './auth.js';

function parseCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? match[1] : null;
}

export async function requireAuth(request, env, allowedRoles) {
  const token = parseCookie(request, 'session');
  const session = token ? await getSession(env.DB, token) : null;

  if (!session) {
    return new Response(JSON.stringify({ error: 'Chưa đăng nhập' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    return new Response(JSON.stringify({ error: 'Không đủ quyền' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return session;
}
