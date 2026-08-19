
function formatDate(date) {
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtml({ guestName, promoCode, discountPercent, expiresAt, giftOffered }) {
  const safeGuestName = escapeHtml(guestName);
  const safePromoCode = escapeHtml(promoCode);
  const giftLine = giftOffered
    ? '<p>Mang mã này đến quầy lễ tân — nếu quà lưu niệm vẫn còn, bạn sẽ được nhận thêm nhé!</p>'
    : '';
  return `
    <div style="font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background:#0D1F14; color:#F5F0E6; padding:32px; max-width:480px; margin:0 auto;">
      <h1 style="color:#C9A84C; font-size:22px;">Hiền Lê Garden Farmstay</h1>
      <p>Xin chào ${safeGuestName},</p>
      <p>Cảm ơn bạn đã chia sẻ trải nghiệm tại Hiền Lê Garden. Đây là mã ưu đãi dành riêng cho bạn:</p>
      <p style="font-size:28px; letter-spacing:2px; color:#C9A84C; font-weight:bold;">${safePromoCode}</p>
      <p>Giảm <strong>${discountPercent}%</strong> cho lần sử dụng dịch vụ tiếp theo, có hiệu lực đến <strong>${formatDate(expiresAt)}</strong>.</p>
      ${giftLine}
      <p>Hẹn gặp lại bạn tại Hiền Lê Garden!</p>
    </div>
  `;
}

export async function sendPromoEmail(env, { to, guestName, promoCode, discountPercent, expiresAt, giftOffered }) {
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { email: 'khuyenmai@hienlegarden.vn', name: 'Hiền Lê Garden' },
        to: [{ email: to, name: guestName }],
        subject: 'Mã ưu đãi từ Hiền Lê Garden Farmstay',
        htmlContent: buildHtml({ guestName, promoCode, discountPercent, expiresAt, giftOffered }),
      }),
    });

    if (!response.ok) {
      console.error('Brevo send failed', response.status, await response.text());
    }
  } catch (err) {
    console.error('Brevo send threw', err);
  }
}
