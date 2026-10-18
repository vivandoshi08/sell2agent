-- Contract v2 (E1 asks n1–n7, S2 asks). Additive only: run after 0001_init.sql.
-- Mirrors packages/shared/src/index.ts. Owner: Neel.

-- n2: wider negotiation states (E1's state machine)
alter table negotiations drop constraint if exists negotiations_status_check;
alter table negotiations add constraint negotiations_status_check check (status in (
  'open','negotiating','agreed','accepted','rejected','paid','abandoned',
  'walked_away','follow_up','escalated','expired'));
alter table negotiations add column if not exists lever_profile jsonb;          -- S2: buyer's lever profile
alter table negotiations add column if not exists policy text;                  -- seller policy used

-- n3: offers (one row per seller offer; accept_deal names a live offer_id)
create table if not exists offers (
  id text primary key,
  negotiation_id text not null references negotiations(id),
  buyer_id text not null,
  round int not null,
  price_cents int not null check (price_cents > 0),
  levers jsonb not null default '[]',             -- LeverPackage (public: id, lever, label)
  final boolean not null default false,
  expires_at timestamptz,
  status text not null default 'live' check (status in ('live','superseded','accepted','expired')),
  created_at timestamptz not null default now()
);
create index if not exists offers_negotiation_idx on offers (negotiation_id, created_at);

-- n4: locked, signed deals
alter table deals add column if not exists offer_id text references offers(id);
alter table deals add column if not exists buyer_id text;
alter table deals add column if not exists levers jsonb not null default '[]';
alter table deals add column if not exists lever_cost_cents int not null default 0; -- PRIVATE: margin after levers
alter table deals add column if not exists expires_at timestamptz;
alter table deals add column if not exists signature text;  -- HMAC over (deal_id, amount, buyer_id, levers, expires_at)

-- S2 / FINAL_ARCHITECTURE §2: lever menu + objective per product policy (PRIVATE)
alter table seller_policies add column if not exists lever_menu jsonb not null default '[]';
alter table seller_policies add column if not exists objective jsonb;
alter table seller_policies add column if not exists policy text not null default 'negotiating';
alter table seller_policies add column if not exists min_margin_after_levers_pct numeric;

-- Live offers for the dashboard
alter publication supabase_realtime add table offers;
