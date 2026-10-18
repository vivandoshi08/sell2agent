-- APPLIED to the shared Supabase project Sun Oct 18, 1:18 am PT (S2, after S1 confirmed the gateway uses the service-role key).
-- Verified: anon reads events (2448) + products (6), reads 0 rows of seller_policies/deals, and an anon insert into events is refused; service_role insert works.
-- Owner to decide and apply: Vivan (E1) / Neel (migrations are frozen; copy into a migration if adopted).
--
-- Why: RLS is off on all 8 public tables, and the dashboard ships the anon key to every browser. Today anyone
-- with that key can read AND write every row, including seller_policies (floors, unit costs), deals and events.
--
-- What this does:
--   * Service role (gateway, exchange, eval scripts, the console's server API) bypasses RLS: nothing changes.
--   * anon / authenticated can only SELECT what the public dashboard needs: events and the public catalog.
--   * Nobody but the service role can read seller_policies, deals, negotiations, runs, seller_memory, or write anything.
--
-- PRECONDITION, check before applying: every server that WRITES must use SUPABASE_SERVICE_ROLE_KEY.
-- packages/shared/src/db.ts falls back to SUPABASE_ANON_KEY when the service key is missing; a deployed
-- service in that state would start failing to log events. Check the gateway's deploy env first.
--
-- Known gap this does NOT close: E1's deal_accepted payload includes unit_cost_cents (and lever_cost_cents),
-- so costs stay readable through events until E1 drops them (S2's run-result job joins costs server-side).
--
-- Roll back: ALTER TABLE ... DISABLE ROW LEVEL SECURITY; (policies can stay; they're ignored when RLS is off).

begin;

alter table public.sellers         enable row level security;
alter table public.products        enable row level security;
alter table public.seller_policies enable row level security;
alter table public.negotiations    enable row level security;
alter table public.deals           enable row level security;
alter table public.events          enable row level security;
alter table public.runs            enable row level security;
alter table public.seller_memory   enable row level security;

-- Public, read-only: the live dashboard (events feed + realtime) and the public catalog.
create policy "public read events"   on public.events   for select to anon, authenticated using (true);
create policy "public read products" on public.products for select to anon, authenticated using (true);
create policy "public read sellers"  on public.sellers  for select to anon, authenticated using (true);

-- No policies on seller_policies, negotiations, deals, runs, seller_memory: service role only.

commit;

-- After applying, verify:
--   * dashboard live mode still loads and updates (anon SELECT on events + realtime)
--   * `pnpm --filter @sa/seller-mcp supabase:smoke` passes (service role writes)
--   * with the anon key: select from seller_policies returns 0 rows; insert into events fails
