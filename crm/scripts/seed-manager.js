// Run once against production after the first deploy:
//   node crm/scripts/seed-manager.js <username> <password>
// then apply the printed SQL with:
//   wrangler d1 execute hien_le_garden_crm --remote --command "<printed SQL>"
import { webcrypto as crypto } from 'node:crypto';

async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256
  );
  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${toHex(saltBytes)}:${toHex(bits)}`;
}

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node seed-manager.js <username> <password>');
  process.exit(1);
}
const hash = await hashPassword(password);
console.log(
  `INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('${username}', '${hash}', 'manager', '${new Date().toISOString()}');`
);
