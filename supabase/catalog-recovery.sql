-- Walk-away recovery: one budget silent keyboard, so a price-blocked buyer has a real better fit (docs/live/recovery.md).
-- Additive and idempotent (safe to re-run); never touches existing rows, so merchant-console edits survive.
-- Apply in the Supabase SQL editor, or: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/catalog-recovery.sql
begin;

insert into products (id, seller_id, category, title, description, specs, list_price_cents, inventory, shipping_days) values
  ('kb_typewell_60', 's_typewell', 'mechanical_keyboard', 'TypeWell 60 Silent',
   '60% compact, silent tactile switches, wired USB-C.',
   '{"layout":"60%","switch":"silent tactile","hot_swap":false,"wireless":false,"warranty":"1 year"}', 9900, 50, 2)
on conflict (id) do nothing;

insert into seller_policies (product_id, floor_price_cents, unit_cost_cents, target_margin_pct, max_rounds, allowed_concessions) values
  ('kb_typewell_60', 7800, 4200, 30, 4, '{free_shipping}')
on conflict (product_id) do nothing;

commit;
