import { generatePromoCode, computeExpiry } from '../../lib/promoCode.js';
import { resolveActivePolicy } from '../../lib/policy.js';
import { sendPromoEmail } from '../../lib/email.js';
import { corsHeaders, handleCorsPreflight } from '../../lib/cors.js';

function jsonError(message, status, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestOptions({ request }) {
  return handleCorsPreflight(request);
}

export async function onRequestPost({ request, env }) {
  const cors = corsHeaders(request);
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400, cors);
  }
  const {
    guestName,
    phone,
    email,
    wantsTelegram,
    rating,
    comment,
    consentGiven,
    stayDate,
    wishesNextTime,
    favoriteActivities,
  } = body;

  if (!consentGiven) {
    return jsonError('Cần đồng ý sử dụng thông tin để tiếp tục', 400, cors);
  }
  if (!email && !wantsTelegram) {
    return jsonError('Cần ít nhất một cách liên hệ (email hoặc Telegram)', 400, cors);
  }
  if (!guestName || !phone || !rating) {
    return jsonError('Thiếu thông tin bắt buộc', 400, cors);
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return jsonError('Đánh giá phải là số từ 1 đến 5', 400, cors);
  }
  if (email && !EMAIL_FORMAT.test(email)) {
    return jsonError('Email không hợp lệ', 400, cors);
  }
  if (guestName.length > 200) {
    return jsonError('Tên khách quá dài', 400, cors);
  }
  if (phone.length > 200) {
    return jsonError('Số điện thoại quá dài', 400, cors);
  }
  if (comment && comment.length > 2000) {
    return jsonError('Nhận xét quá dài', 400, cors);
  }
  if (stayDate && isNaN(Date.parse(stayDate))) {
    return jsonError('Ngày lưu trú không hợp lệ', 400, cors);
  }
  if (wishesNextTime && wishesNextTime.length > 2000) {
    return jsonError('Mong muốn lần sau quá dài', 400, cors);
  }
  if (favoriteActivities !== undefined && !Array.isArray(favoriteActivities)) {
    return jsonError('Hoạt động yêu thích không hợp lệ', 400, cors);
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
      promo_code, discount_percent, promo_expires_at, promo_status, gift_offered, gift_claimed,
      stay_date, wishes_next_time, favorite_activities)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'unused', ?, 0, ?, ?, ?)`
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
      giftOffered ? 1 : 0,
      stayDate || null,
      wishesNextTime || null,
      favoriteActivities && favoriteActivities.length ? JSON.stringify(favoriteActivities) : null
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
    { status: 201, headers: { 'Content-Type': 'application/json', ...cors } }
  );
}
