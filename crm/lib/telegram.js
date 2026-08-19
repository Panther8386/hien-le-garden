
function formatDate(date) {
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function escapeMarkdown(str) {
  return String(str).replace(/([_*`\[])/g, '\\$1');
}

export async function sendTelegramMessage(env, { chatId, guestName, promoCode, discountPercent, expiresAt, giftOffered }) {
  const safeGuestName = escapeMarkdown(guestName);
  const safePromoCode = escapeMarkdown(promoCode);
  const giftLine = giftOffered ? '\n🎁 Mang mã này đến quầy lễ tân — nếu quà lưu niệm vẫn còn, bạn sẽ được nhận thêm nhé!' : '';
  const text =
    `🌿 *Hiền Lê Garden Farmstay*\n\n` +
    `Xin chào ${safeGuestName}, cảm ơn bạn đã chia sẻ trải nghiệm!\n\n` +
    `Mã ưu đãi của bạn: *${safePromoCode}*\n` +
    `Giảm *${discountPercent}%* cho lần sau, có hiệu lực đến *${formatDate(expiresAt)}*.` +
    giftLine;

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    if (!response.ok) {
      console.error('Telegram send failed', response.status, await response.text());
    }
  } catch (err) {
    console.error('Telegram send threw', err);
  }
}
