// crm/public/admin/manager.js
async function loadPolicies() {
  const response = await fetch('/api/policy');
  const errorEl = document.getElementById('policyLoadError');
  errorEl.textContent = '';

  if (!response.ok) {
    const body = await response.json();
    errorEl.textContent = body.error || 'Có lỗi khi tải chương trình';
    return;
  }

  const policies = await response.json();
  if (!Array.isArray(policies)) {
    errorEl.textContent = 'Dữ liệu chương trình không hợp lệ';
    return;
  }

  const tbody = document.querySelector('#policyTable tbody');
  tbody.innerHTML = '';
  policies.forEach((p) => {
    const tr = document.createElement('tr');
    const tdDiscount = document.createElement('td');
    tdDiscount.textContent = p.discountPercent + '%';
    const tdFrom = document.createElement('td');
    tdFrom.textContent = p.validFrom;
    const tdTo = document.createElement('td');
    tdTo.textContent = p.validTo;
    const tdGift = document.createElement('td');
    tdGift.textContent = p.giftEnabled ? 'Có' : 'Không';
    tr.appendChild(tdDiscount);
    tr.appendChild(tdFrom);
    tr.appendChild(tdTo);
    tr.appendChild(tdGift);
    tbody.appendChild(tr);
  });
}

async function loadGiftInventory() {
  const response = await fetch('/api/gift-inventory');
  if (!response.ok) {
    return;
  }
  const data = await response.json();
  if (data && data.name && data.stockCount !== undefined) {
    document.getElementById('giftInventoryDisplay').textContent = `Hiện có: ${data.stockCount} ${data.name}`;
  }
}

document.getElementById('policyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const errorEl = document.getElementById('policyError');
  errorEl.textContent = '';

  const response = await fetch('/api/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      discountPercent: Number(data.get('discountPercent')),
      validFrom: data.get('validFrom'),
      validTo: data.get('validTo'),
      giftEnabled: data.get('giftEnabled') === 'on',
    }),
  });

  if (!response.ok) {
    const body = await response.json();
    errorEl.textContent = body.error || 'Có lỗi khi lưu chương trình';
    return;
  }

  event.target.reset();
  await loadPolicies();
});

document.getElementById('giftForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const errorEl = document.getElementById('giftError');
  errorEl.textContent = '';

  const response = await fetch('/api/gift-inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: data.get('name'), stockCount: Number(data.get('stockCount')) }),
  });

  if (!response.ok) {
    const body = await response.json();
    errorEl.textContent = body.error || 'Có lỗi khi cập nhật kho';
    return;
  }

  event.target.reset();
  await loadGiftInventory();
});

loadPolicies();
loadGiftInventory();
