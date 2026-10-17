-- FROZEN SCHEMA. Mirrors packages/shared/src/index.ts. Don't edit without the team.

create table sellers (
  id text primary key,
  name text not null,
  mcp_url text not null,
  strategy text not null check (strategy in ('static','negotiating'))
);

create table products (
  id text primary key,
  seller_id text not null references sellers(id),
  category text not null,
  title text not null,
  description text not null,
  specs jsonb not null default '{}',
  list_price_cents int not null check (list_price_cents > 0),
  inventory int not null default 0,
  shipping_days int not null default 3
);
create index on products (category);

-- PRIVATE: only seller-mcp reads this. Never expose via marketplace.
create table seller_policies (
  product_id text primary key references products(id),
  floor_price_cents int not null,
  unit_cost_cents int not null,
  target_margin_pct numeric not null,
  max_rounds int not null default 4,
  allowed_concessions text[] not null default '{}'
);

create table negotiations (
  id text primary key,
  run_id text not null,
  buyer_id text not null,
  buyer_model text not null,
  seller_id text not null references sellers(id),
  product_id text not null references products(id),
  quantity int not null default 1,
  round int not null default 0,
  last_price_cents int,
  status text not null default 'open' check (status in ('open','accepted','rejected','paid','abandoned')),
  created_at timestamptz not null default now()
);

create table deals (
  id text primary key,
  negotiation_id text not null references negotiations(id),
  final_price_cents int not null,
  quantity int not null,
  unit_cost_cents int not null,
  stripe_payment_intent_id text,
  paid boolean not null default false,
  created_at timestamptz not null default now()
);

-- THE INTEGRATION BUS. Seller + buyer write; dashboard reads.
create table events (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  buyer_id text,
  buyer_model text,
  seller_id text,
  product_id text,
  negotiation_id text,
  actor text not null check (actor in ('buyer','seller','marketplace','harness')),
  type text not null,
  price_cents int,
  payload jsonb not null default '{}',
  ts timestamptz not null default now()
);
create index on events (run_id, ts);

create table runs (
  id text primary key,
  label text not null,
  seller_strategy text not null,
  config jsonb not null,
  result jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Seller memory: what worked in past negotiations (written by seller-mcp).
create table seller_memory (
  id uuid primary key default gen_random_uuid(),
  seller_id text not null,
  product_id text,
  buyer_model text,
  insight text not null,
  outcome text, -- 'converted' | 'lost'
  created_at timestamptz not null default now()
);

-- Live dashboard updates
alter publication supabase_realtime add table events;
