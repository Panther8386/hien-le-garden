import { sendTelegramMessage } from '../../../lib/telegram.js';

export async function onRequestPost({ request, env }) {
  const update = await request.json();
  const message = update.message;

  if (!message || !message.text || !message.text.startsWith('/start ')) {
    return new Response('ok', { status: 200 });
  }

  const feedbackId = message.text.replace('/start ', '').trim();
  const chatId = String(message.chat.id);

  const row = await env.DB.prepare(
    `SELECT guest_name, promo_code, discount_percent, promo_expires_at, gift_offered
     FROM feedback_responses WHERE id = ?`
  )
    .bind(feedbackId)
    .first();

  if (!row) {
    return new Response('ok', { status: 200 });
  }

  await env.DB.prepare(`UPDATE feedback_responses SET telegram_chat_id = ? WHERE id = ?`)
    .bind(chatId, feedbackId)
    .run();

  await sendTelegramMessage(env, {
    chatId,
    guestName: row.guest_name,
    promoCode: row.promo_code,
    discountPercent: row.discount_percent,
    expiresAt: new Date(row.promo_expires_at),
    giftOffered: !!row.gift_offered,
  });

  return new Response('ok', { status: 200 });
}
