import { requireAuth } from '../../../../lib/requireAuth.js';

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const feedback = await env.DB.prepare(`SELECT id, gift_claimed, gift_offered FROM feedback_responses WHERE promo_code = ?`)
    .bind(params.code).first();
  if (!feedback) {
    return new Response(JSON.stringify({ error: 'Không tìm thấy mã' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  if (!feedback.gift_offered) {
    return new Response(JSON.stringify({ error: 'Mã này không có quà' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  if (feedback.gift_claimed) {
    return new Response(JSON.stringify({ error: 'Đã phát quà cho mã này rồi' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  const gift = await env.DB.prepare(`SELECT id, stock_count FROM gift_inventory ORDER BY id DESC LIMIT 1`).first();
  if (!gift || gift.stock_count <= 0) {
    return new Response(JSON.stringify({ error: 'Hết quà' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE gift_inventory SET stock_count = stock_count - 1, updated_at = ? WHERE id = ? AND stock_count > 0`)
      .bind(new Date().toISOString(), gift.id),
    env.DB.prepare(`UPDATE feedback_responses SET gift_claimed = 1 WHERE id = ?`).bind(feedback.id),
  ]);

  // Check if the stock decrement actually happened (guards against TOCTOU race)
  if (results[0].meta.changes === 0) {
    return new Response(JSON.stringify({ error: 'Hết quà' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
