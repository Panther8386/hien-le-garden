export async function onRequestPost({ request, env }) {
  // Extract session token from Cookie header
  const cookieHeader = request.headers.get('Cookie') || '';
  const sessionMatch = cookieHeader.match(/session=([^;]+)/);
  const token = sessionMatch ? sessionMatch[1] : null;

  // Delete the session from the database if it exists
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }

  return new Response(null, {
    status: 204,
    headers: {
      'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    },
  });
}
