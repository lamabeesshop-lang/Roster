// Usage: npm run create-user -- <username> "<Full Name>" <password> [--admin]
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const [username, name, password] = process.argv.slice(2);
if (!username || !name || !password || password.length < 8) {
  console.error('Usage: npm run create-user -- <username> "<Full Name>" <password (8+ chars)> [--admin]');
  process.exit(1);
}
const admin = process.argv.includes('--admin') ? 1 : 0;
db.prepare(`INSERT INTO users (username, name, password_hash, is_admin) VALUES (?, ?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET name = excluded.name, password_hash = excluded.password_hash, is_admin = excluded.is_admin`)
  .run(username, name, bcrypt.hashSync(password, 12), admin);
console.log(`User "${username}" saved${admin ? ' (administrator)' : ''}.`);
