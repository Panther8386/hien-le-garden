import { requireAuth } from '../../../../lib/requireAuth.js';

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const row = await env.DB.prepare(`SELECT promo_status, promo_expires_at FROM feedback_responses WHERE promo_code = ?`)
    .bind(params.code).first();

  if (!row) {
    return new Response(JSON.stringify({ error: 'Không tìm thấy mã' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  if (row.promo_status === 'used') {
    return new Response(JSON.stringify({ error: 'Mã đã được sử dụng' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }
  if (row.promo_status === 'unused' && new Date(row.promo_expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: 'Mã đã hết hạn' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  await env.DB.prepare(
    `UPDATE feedback_responses SET promo_status = 'used', redeemed_at = ?, redeemed_by = ? WHERE promo_code = ?`
  ).bind(new Date().toISOString(), auth.username, params.code).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
