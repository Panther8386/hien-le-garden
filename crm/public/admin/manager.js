// crm/public/admin/manager.js
async function loadPolicies() {
  const response = await fetch('/api/policy');
  const policies = await response.json();
  const tbody = document.querySelector('#policyTable tbody');
  tbody.innerHTML = policies
    .map((p) => `<tr><td>${p.discountPercent}%</td><td>${p.validFrom}</td><td>${p.validTo}</td><td>${p.giftEnabled ? 'Có' : 'Không'}</td></tr>`)
    .join('');
}

document.getElementById('policyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  await fetch('/api/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      discountPercent: Number(data.get('discountPercent')),
      validFrom: data.get('validFrom'),
      validTo: data.get('validTo'),
      giftEnabled: data.get('giftEnabled') === 'on',
    }),
  });
  event.target.reset();
  await loadPolicies();
});

document.getElementById('giftForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  await fetch('/api/gift-inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: data.get('name'), stockCount: Number(data.get('stockCount')) }),
  });
});

loadPolicies();
