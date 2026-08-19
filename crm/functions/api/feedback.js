import { generatePromoCode, computeExpiry } from '../../lib/promoCode.js';
import { resolveActivePolicy } from '../../lib/policy.js';
import { sendPromoEmail } from '../../lib/email.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { guestName, phone, email, wantsTelegram, rating, comment, consentGiven } = body;

  if (!consentGiven) {
    return jsonError('Cần đồng ý sử dụng thông tin để tiếp tục', 400);
  }
  if (!email && !wantsTelegram) {
    return jsonError('Cần ít nhất một cách liên hệ (email hoặc Telegram)', 400);
  }
  if (!guestName || !phone || !rating) {
    return jsonError('Thiếu thông tin bắt buộc', 400);
  }

  const now = new Date();
  const todayISODate = now.toISOString().slice(0, 10);
  const policy = await resolveActivePolicy(env.DB, todayISODate);

  let giftOffered = false;
  if (policy.giftEnabled) {
    const gift = await env.DB.prepare(`SELECT stock_count FROM gift_inventory ORDER BY id DESC LIMIT 1`).first();
    giftOffered = !!gift && gift.stock_count > 0;
  }

  const feedbackId = crypto.randomUUID();
  const promoCode = generatePromoCode();
  const expiresAt = computeExpiry(now);

  await env.DB.prepare(
    `INSERT INTO feedback_responses
     (id, submitted_at, guest_name, phone, email, wants_telegram, rating, comment, consent_given,
      promo_code, discount_percent, promo_expires_at, promo_status, gift_offered, gift_claimed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'unused', ?, 0)`
  )
    .bind(
      feedbackId,
      now.toISOString(),
      guestName,
      phone,
      email || null,
      wantsTelegram ? 1 : 0,
      rating,
      comment || null,
      promoCode,
      policy.discountPercent,
      expiresAt.toISOString(),
      giftOffered ? 1 : 0
    )
    .run();

  if (email) {
    await sendPromoEmail(env, {
      to: email,
      guestName,
      promoCode,
      discountPercent: policy.discountPercent,
      expiresAt,
      giftOffered,
    });
  }

  return new Response(
    JSON.stringify({
      feedbackId,
      promoCode,
      discountPercent: policy.discountPercent,
      expiresAt: expiresAt.toISOString(),
      giftOffered,
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } }
  );
}
