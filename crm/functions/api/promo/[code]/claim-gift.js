import { requireAuth } from '../../../../lib/requireAuth.js';

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const feedback = await env.DB.prepare(`SELECT id, gift_claimed FROM feedback_responses WHERE promo_code = ?`)
    .bind(params.code).first();
  if (!feedback) {
    return new Response(JSON.stringify({ error: 'Không tìm thấy mã' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const gift = await env.DB.prepare(`SELECT id, stock_count FROM gift_inventory ORDER BY id DESC LIMIT 1`).first();
  if (!gift || gift.stock_count <= 0) {
    return new Response(JSON.stringify({ error: 'Hết quà' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  await env.DB.batch([
    env.DB.prepare(`UPDATE gift_inventory SET stock_count = stock_count - 1, updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), gift.id),
    env.DB.prepare(`UPDATE feedback_responses SET gift_claimed = 1 WHERE id = ?`).bind(feedback.id),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
