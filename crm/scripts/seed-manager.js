// Run once against production after the first deploy:
//   node crm/scripts/seed-manager.js <username> <password> [role]
// role defaults to 'manager' if omitted; pass 'reception' to create a reception account.
// then apply the printed SQL with:
//   wrangler d1 execute hien_le_garden_crm --remote --command "<printed SQL>"
import { webcrypto as crypto } from 'node:crypto';

const VALID_ROLES = ['manager', 'reception'];

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

const [username, password, role = 'manager'] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node seed-manager.js <username> <password> [role]');
  process.exit(1);
}
if (!VALID_ROLES.includes(role)) {
  console.error(`Usage: node seed-manager.js <username> <password> [role]\nrole must be one of: ${VALID_ROLES.join(', ')}`);
  process.exit(1);
}
const hash = await hashPassword(password);
console.log(
  `INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('${username}', '${hash}', '${role}', '${new Date().toISOString()}');`
);
