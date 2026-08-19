import { requireAuth } from '../../lib/requireAuth.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['manager']);
  if (auth instanceof Response) return auth;

  const { discountPercent, validFrom, validTo, giftEnabled } = await request.json();
  await env.DB.prepare(
    `INSERT INTO promo_policy (discount_percent, valid_from, valid_to, is_active, gift_enabled, updated_by, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(discountPercent, validFrom, validTo, giftEnabled ? 1 : 0, auth.username, new Date().toISOString())
    .run();

  return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(
    `SELECT id, discount_percent AS discountPercent, valid_from AS validFrom, valid_to AS validTo,
            is_active AS isActive, gift_enabled AS giftEnabled
     FROM promo_policy ORDER BY id DESC`
  ).all();

  return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
