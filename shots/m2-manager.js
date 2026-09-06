const { runAdminShots } = require('./lib');
const path = require('path');

const outDir = path.join('docs', 'user-guides', 'screenshots', 'm2-manager');
const ROLE = 'manager';
const USER = 'quan_ly_thu';

const shots = [
  { name: '01-trang-dang-nhap', path: '/admin/login.html' },
  { name: '02-tong-quan-so-lieu', path: '/admin/dashboard.html' },
  { name: '03-so-thu-chi-tong-quan', path: '/admin/finance.html' },
  {
    name: '04-so-thu-chi-form-them',
    path: '/admin/finance.html',
    before: async (page) => { await page.click('#openAddTransactionBtn'); },
    clip: '#financeFormOverlay .confirm-box',
  },
  { name: '05-van-hanh-hom-nay', path: '/admin/reception.html' },
  { name: '06-nhat-ky-thao-tac', path: '/admin/audit-log.html' },
  { name: '07-quan-ly-tai-khoan', path: '/admin/users.html' },
  { name: '08-kho-template-form', path: '/admin/templates.html', clip: '#templateForm' },
  { name: '09-cau-hinh-khuyen-mai', path: '/admin/manager.html' },
  { name: '10-bang-gia-dich-vu-readonly', path: '/admin/catalog.html' },
  { name: '11-chinh-sach-hoan-coc-readonly', path: '/admin/cancellation-policy.html' },
  { name: '12-doi-mat-khau', path: '/admin/change-password.html' },
];

runAdminShots(outDir, ROLE, USER, shots).then(() => console.log('DONE m2')).catch((e) => { console.error(e); process.exit(1); });
