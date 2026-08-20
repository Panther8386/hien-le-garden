const form = document.getElementById('surveyForm');
const errorEl = document.getElementById('formError');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';

  const data = new FormData(form);
  const favoriteActivities = data.getAll('favoriteActivities');
  const payload = {
    guestName: data.get('guestName'),
    phone: data.get('phone'),
    email: data.get('email') || undefined,
    wantsTelegram: data.get('wantsTelegram') === 'on',
    rating: Number(data.get('rating')),
    comment: data.get('comment') || undefined,
    consentGiven: data.get('consentGiven') === 'on',
    stayDate: data.get('stayDate') || undefined,
    wishesNextTime: data.get('wishesNextTime') || undefined,
    favoriteActivities: favoriteActivities.length ? favoriteActivities : undefined,
  };

  const response = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json();
    errorEl.textContent = body.error || 'Có lỗi xảy ra, vui lòng thử lại.';
    return;
  }

  const result = await response.json();
  form.hidden = true;

  const confirmation = document.getElementById('confirmation');
  confirmation.hidden = false;
  document.getElementById('promoCode').textContent = result.promoCode;
  document.getElementById('promoDetails').textContent =
    `Giảm ${result.discountPercent}% cho lần sau, có hiệu lực đến ${new Date(result.expiresAt).toLocaleDateString('vi-VN')}.`;

  if (result.giftOffered) {
    document.getElementById('giftLine').hidden = false;
  }
  if (payload.wantsTelegram) {
    const link = document.getElementById('telegramLink');
    link.href = `https://t.me/HienLeGardenBot?start=${result.feedbackId}`;
    link.hidden = false;
  }
});
