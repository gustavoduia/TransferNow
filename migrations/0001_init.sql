-- TransferNow — contas, assinaturas, cotas, transferências na nuvem e registros de acesso.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  google_sub    TEXT UNIQUE,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,           -- sha256 do token do cookie
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- Uma linha por assinatura do Mercado Pago (preapproval).
CREATE TABLE subscriptions (
  id                 TEXT PRIMARY KEY,     -- id da preapproval no Mercado Pago
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan               TEXT NOT NULL,        -- starter | scale | pro
  status             TEXT NOT NULL,        -- pending | authorized | paused | cancelled
  amount             REAL,
  next_payment_date  INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX subscriptions_user ON subscriptions(user_id);

-- Uso do mês. subject = 'u:<user>' | 'd:<aparelho>' | 'i:<hash do IP>'; period = 'AAAA-MM'.
CREATE TABLE usage (
  subject    TEXT NOT NULL,
  period     TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  transfers  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, period)
);

-- Transferências guardadas temporariamente na nuvem (planos pagos).
CREATE TABLE cloud_transfers (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,             -- uploading | ready | done | expired | cancelled
  file_count    INTEGER NOT NULL,
  total_bytes   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX cloud_transfers_expiry ON cloud_transfers(status, expires_at);
CREATE INDEX cloud_transfers_user ON cloud_transfers(user_id);
CREATE INDEX cloud_transfers_code ON cloud_transfers(code, status);

CREATE TABLE cloud_files (
  transfer_id    TEXT NOT NULL REFERENCES cloud_transfers(id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,
  name           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  type           TEXT NOT NULL,
  r2_key         TEXT NOT NULL,
  upload_id      TEXT,
  uploaded       INTEGER NOT NULL DEFAULT 0,
  downloaded_at  INTEGER,
  PRIMARY KEY (transfer_id, idx)
);

-- Registros de acesso (Marco Civil da Internet, art. 15): IP, data e hora, guardados por 6 meses.
-- Acesso restrito; só saem daqui por ordem judicial.
CREATE TABLE access_log (
  ts       INTEGER NOT NULL,
  ip       TEXT NOT NULL,
  port     TEXT,
  event    TEXT NOT NULL,
  user_id  TEXT,
  ref      TEXT
);
CREATE INDEX access_log_ts ON access_log(ts);
