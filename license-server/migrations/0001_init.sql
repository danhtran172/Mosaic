-- A purchase. Keys are stored only as SHA-256 hashes; the plain key exists
-- in the buyer's email (Lemon Squeezy) or in their bank-transfer order.
CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  email TEXT NOT NULL,
  source TEXT NOT NULL,                 -- lemonsqueezy | bank | manual
  device_limit INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | revoked
  external_id TEXT,                     -- Lemon Squeezy license key id
  order_ref TEXT,                       -- Lemon Squeezy order id, or bank order code
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX licenses_external ON licenses (external_id);
CREATE INDEX licenses_order ON licenses (order_ref);

-- One row per computer a license runs on.
CREATE TABLE activations (
  license_id TEXT NOT NULL REFERENCES licenses (id) ON DELETE CASCADE,
  machine TEXT NOT NULL,                -- the app's machine code, e.g. 2CTHB-EJ64E
  name TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (license_id, machine)
);

-- A bank-transfer purchase waiting for (or matched to) its payment.
CREATE TABLE orders (
  code TEXT PRIMARY KEY,                -- the transfer description is "MOSAIC <code>"
  email TEXT NOT NULL,
  machine TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid
  license_id TEXT REFERENCES licenses (id),
  license_key TEXT,                     -- handed to the buyer's app once paid
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX orders_buyer ON orders (email, machine, status);

-- Every incoming bank transaction, so a webhook delivered twice counts once.
CREATE TABLE bank_transactions (
  id INTEGER PRIMARY KEY,               -- SePay's transaction id
  order_code TEXT,
  amount INTEGER NOT NULL,
  content TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
