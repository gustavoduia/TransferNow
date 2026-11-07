-- Checkout transparente: preço anual, ciclo da assinatura e períodos pré-pagos (Pix e boleto).

ALTER TABLE plans ADD COLUMN price_yearly REAL;
ALTER TABLE subscriptions ADD COLUMN cycle TEXT NOT NULL DEFAULT 'monthly';   -- monthly | yearly
ALTER TABLE subscriptions ADD COLUMN method TEXT NOT NULL DEFAULT 'card';

-- Período pré-pago: um pagamento Pix ou boleto libera o plano por 30 ou 365 dias.
CREATE TABLE passes (
  id                  TEXT PRIMARY KEY,          -- nosso id (vai no external_reference)
  payment_id          TEXT UNIQUE,               -- id do pagamento no Mercado Pago
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan                TEXT NOT NULL,
  cycle               TEXT NOT NULL,             -- monthly | yearly
  method              TEXT NOT NULL,             -- pix | boleto
  amount              REAL NOT NULL,
  status              TEXT NOT NULL,             -- pending | approved | rejected | cancelled | expired | refunded
  qr_code             TEXT,
  qr_base64           TEXT,
  ticket_url          TEXT,
  barcode             TEXT,
  pay_until           INTEGER,                   -- vencimento do Pix/boleto
  starts_at           INTEGER,
  ends_at             INTEGER,
  reminded_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX passes_user ON passes(user_id, status);
CREATE INDEX passes_ending ON passes(status, ends_at);
