-- ─── Run once — utility biller type reference table ───────────────────────────
-- Gives us a clean enum for bill types that the frontend can use to
-- render icons/labels without hardcoding strings everywhere.

CREATE TABLE IF NOT EXISTS utility_biller_types (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  icon_key    TEXT            -- frontend maps this to an icon component
);

INSERT INTO utility_biller_types (code, label, icon_key) VALUES
  ('ELECTRICITY_BILL_PAYMENT',          'Electricity',        'zap'),
  ('WATER_BILL_PAYMENT',                'Water',              'droplet'),
  ('TV_BILL_PAYMENT',                   'Cable / TV',         'tv'),
  ('INTERNET_BILL_PAYMENT',             'Internet (Mobile)',  'wifi'),
  ('INTERNET_BROADBAND_BILL_PAYMENT',   'Internet (Broadband)','wifi'),
  ('GAS_BILL_PAYMENT',                  'Gas',                'flame'),
  ('TOLL_BILL_PAYMENT',                 'Toll',               'car')
ON CONFLICT (code) DO NOTHING;

-- Add a status-poll column to orders so we know when to stop polling
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS poll_until TIMESTAMPTZ;

-- Index to efficiently find orders that still need polling
CREATE INDEX IF NOT EXISTS orders_poll_until_idx
  ON orders (poll_until)
  WHERE poll_until IS NOT NULL AND status = 'PROCESSING';