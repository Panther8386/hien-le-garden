// crm/public/admin/reception.js
let currentCode = null;

document.getElementById('lookupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = new FormData(event.target).get('code');
  const response = await fetch(`/api/promo/${encodeURIComponent(code)}`);
  const errorEl = document.getElementById('lookupError');
  errorEl.textContent = '';

  if (!response.ok) {
    const body = await response.json();
    errorEl.textContent = body.error || 'Có lỗi xảy ra';
    document.getElementById('result').classList.add('hidden');
    return;
  }

  currentCode = code;
  const data = await response.json();
  document.getElementById('guestName').textContent = data.guestName;
  document.getElementById('discountPercent').textContent = data.discountPercent;
  document.getElementById('expiresAt').textContent = new Date(data.expiresAt).toLocaleDateString('vi-VN');
  document.getElementById('status').textContent = data.status;
  document.getElementById('claimGiftBtn').style.display = data.giftOffered && !data.giftClaimed ? 'inline-block' : 'none';
  document.getElementById('result').classList.remove('hidden');
});

document.getElementById('redeemBtn').addEventListener('click', async () => {
  const response = await fetch(`/api/promo/${encodeURIComponent(currentCode)}/redeem`, { method: 'POST' });
  const errorEl = document.getElementById('actionError');
  if (!response.ok) {
    errorEl.textContent = (await response.json()).error;
    return;
  }
  document.getElementById('status').textContent = 'used';
  errorEl.textContent = '';
});

document.getElementById('claimGiftBtn').addEventListener('click', async () => {
  const response = await fetch(`/api/promo/${encodeURIComponent(currentCode)}/claim-gift`, { method: 'POST' });
  const errorEl = document.getElementById('actionError');
  if (!response.ok) {
    errorEl.textContent = (await response.json()).error;
    return;
  }
  document.getElementById('claimGiftBtn').style.display = 'none';
  errorEl.textContent = '';
});
