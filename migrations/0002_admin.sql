-- Painel de administração: papéis, bloqueios, planos editáveis, financeiro, BI, campanhas e anúncios.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';          -- user | admin
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';      -- active | blocked | banned
ALTER TABLE users ADD COLUMN status_reason TEXT;
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
ALTER TABLE users ADD COLUMN marketing_opt_out INTEGER NOT NULL DEFAULT 0;
CREATE INDEX users_created ON users(created_at);

-- Planos editáveis pelo painel. -1 = ilimitado.
CREATE TABLE plans (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  monthly_gb         INTEGER NOT NULL,
  monthly_transfers  INTEGER NOT NULL,
  max_file_gb        INTEGER NOT NULL,
  cloud_hours        INTEGER NOT NULL,
  ads                INTEGER NOT NULL,
  price              REAL,
  for_sale           INTEGER NOT NULL DEFAULT 1,
  sort               INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
INSERT INTO plans VALUES
  ('free',    'Gratuito', 5,   10,  5,  0,   1, NULL, 0, 0, 0),
  ('starter', 'Starter',  50,  100, 10, 24,  0, NULL, 1, 1, 0),
  ('scale',   'Scale',    200, 200, 50, 72,  0, NULL, 1, 2, 0),
  ('pro',     'Pró',      -1,  -1,  -1, 168, 0, NULL, 1, 3, 0);

-- Cortesias concedidas pelo suporte (plano grátis por um período).
CREATE TABLE plan_grants (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan        TEXT NOT NULL,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  reason      TEXT,
  granted_by  TEXT NOT NULL,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX plan_grants_user ON plan_grants(user_id);

-- Cobranças das assinaturas (authorized_payments do Mercado Pago).
CREATE TABLE payments (
  id               TEXT PRIMARY KEY,
  subscription_id  TEXT NOT NULL,
  user_id          TEXT,
  plan             TEXT,
  amount           REAL NOT NULL,
  status           TEXT NOT NULL,        -- approved | pending | rejected | refunded | ...
  paid_at          INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX payments_paid ON payments(paid_at);
CREATE INDEX payments_user ON payments(user_id);

-- Uma linha por transferência (P2P ou nuvem), para o BI.
CREATE TABLE transfers (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  day           TEXT NOT NULL,           -- AAAA-MM-DD (UTC-3)
  kind          TEXT NOT NULL,           -- p2p | cloud
  plan          TEXT NOT NULL,
  user_id       TEXT,
  subject       TEXT,                    -- aparelho, para o gratuito sem login
  bytes         INTEGER NOT NULL,
  files         INTEGER NOT NULL,
  status        TEXT NOT NULL,           -- started | done | failed | rejected | uploading | ready | expired | removed | cancelled
  country       TEXT,
  relay         INTEGER,
  completed_at  INTEGER
);
CREATE INDEX transfers_day ON transfers(day);
CREATE INDEX transfers_user ON transfers(user_id, ts);

-- Bloqueios de quem usa sem conta (IP com hash, aparelho) e de e-mails.
CREATE TABLE bans (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,             -- ip | device | email
  value       TEXT NOT NULL,
  label       TEXT,                      -- como o valor aparece no painel
  reason      TEXT,
  expires_at  INTEGER,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX bans_lookup ON bans(kind, value);

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX notes_user ON notes(user_id);

CREATE TABLE admin_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  admin   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT
);
CREATE INDEX admin_audit_ts ON admin_audit(ts);

CREATE TABLE campaigns (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  segment      TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  cta_label    TEXT,
  status       TEXT NOT NULL,            -- draft | sending | done
  total        INTEGER NOT NULL DEFAULT 0,
  sent         INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

CREATE TABLE campaign_sends (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  email        TEXT NOT NULL,
  status       TEXT NOT NULL,            -- queued | sent | failed
  sent_at      INTEGER,
  PRIMARY KEY (campaign_id, user_id)
);

-- Configurações da plataforma editáveis no painel (ex.: anúncios).
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Resultado dos vídeos recompensados, agregado por dia.
CREATE TABLE ad_stats (
  day      TEXT NOT NULL,
  moment   TEXT NOT NULL,                -- send | receive
  outcome  TEXT NOT NULL,                -- shown | granted | unavailable | aborted | closed_early
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, moment, outcome)
);

-- Erros e eventos de sistema para a tela de saúde.
CREATE TABLE system_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  level   TEXT NOT NULL,                 -- info | warn | error
  event   TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX system_events_ts ON system_events(ts);
