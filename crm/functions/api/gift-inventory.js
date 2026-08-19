import { requireAuth } from '../../lib/requireAuth.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['manager']);
  if (auth instanceof Response) return auth;

  const { name, stockCount } = await request.json();
  const existing = await env.DB.prepare(`SELECT id FROM gift_inventory ORDER BY id DESC LIMIT 1`).first();

  if (existing) {
    await env.DB.prepare(`UPDATE gift_inventory SET name = ?, stock_count = ?, updated_at = ? WHERE id = ?`)
      .bind(name, stockCount, new Date().toISOString(), existing.id)
      .run();
  } else {
    await env.DB.prepare(`INSERT INTO gift_inventory (name, stock_count, updated_at) VALUES (?, ?, ?)`)
      .bind(name, stockCount, new Date().toISOString())
      .run();
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const row = await env.DB.prepare(`SELECT name, stock_count AS stockCount FROM gift_inventory ORDER BY id DESC LIMIT 1`).first();
  return new Response(JSON.stringify(row || { name: null, stockCount: 0 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
