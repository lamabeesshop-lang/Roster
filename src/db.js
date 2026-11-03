const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY,
  call_sign TEXT NOT NULL,
  id_number TEXT,
  surname TEXT NOT NULL,
  full_names TEXT NOT NULL,
  initials TEXT,
  address TEXT,
  suburb TEXT,
  postal_code TEXT,
  cellphone TEXT,
  email TEXT,
  radio_model TEXT NOT NULL,
  serial_number TEXT,
  price_cents INTEGER NOT NULL,
  plan_months INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | paid | terminated
  notes TEXT,
  signed_file TEXT,
  signed_file_name TEXT,
  signed_uploaded_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  agreement_id INTEGER NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  paid_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reference TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  agreement_id INTEGER NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  period TEXT NOT NULL,                -- YYYY-MM
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  instalment_label TEXT NOT NULL,
  instalment_cents INTEGER NOT NULL,   -- this month's instalment
  arrears_cents INTEGER NOT NULL,      -- unpaid from earlier months
  amount_due_cents INTEGER NOT NULL,   -- instalment + arrears
  paid_to_date_cents INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL,      -- outstanding on the full price
  token TEXT NOT NULL UNIQUE,          -- for the shareable PDF link
  emailed_at TEXT,
  whatsapp_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (agreement_id, period)
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  agreement_id INTEGER REFERENCES agreements(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function log(userId, agreementId, action) {
  db.prepare('INSERT INTO activity (user_id, agreement_id, action) VALUES (?, ?, ?)').run(userId || null, agreementId || null, action);
}

module.exports = db;
module.exports.log = log;
