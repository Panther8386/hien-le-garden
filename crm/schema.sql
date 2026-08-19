CREATE TABLE feedback_responses (
  id TEXT PRIMARY KEY,
  submitted_at TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  wants_telegram INTEGER NOT NULL DEFAULT 0,
  telegram_chat_id TEXT,
  rating INTEGER NOT NULL,
  comment TEXT,
  consent_given INTEGER NOT NULL,
  promo_code TEXT NOT NULL UNIQUE,
  discount_percent INTEGER NOT NULL,
  promo_expires_at TEXT NOT NULL,
  promo_status TEXT NOT NULL DEFAULT 'unused',
  redeemed_at TEXT,
  redeemed_by TEXT,
  gift_offered INTEGER NOT NULL DEFAULT 0,
  gift_claimed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_feedback_promo_code ON feedback_responses(promo_code);

CREATE TABLE promo_policy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discount_percent INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  gift_enabled INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE gift_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stock_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE staff_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reception', 'manager')),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
