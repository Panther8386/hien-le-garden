// crm/public/admin/login.js
document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
  });

  if (!response.ok) {
    document.getElementById('loginError').textContent = 'Sai tài khoản hoặc mật khẩu';
    return;
  }

  const { role } = await response.json();
  window.location.href = role === 'manager' ? 'manager.html' : 'reception.html';
});
