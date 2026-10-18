-- S1 catalog expansion for an already-seeded database (additive, idempotent: safe to re-run).
-- Adds the fourth keyboard seller (Hushline) and a stated warranty on every product, matching seed.sql.
-- Never touches existing seller_policies rows, so merchant-console edits (floors, extras) survive.
-- Apply in the Supabase SQL editor, or: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/catalog-expand.sql
begin;

insert into sellers (id, name, mcp_url, strategy) values
  ('s_hushline', 'Hushline', 'http://localhost:3001/mcp/s_hushline', 'negotiating')
on conflict (id) do nothing;

insert into products (id, seller_id, category, title, description, specs, list_price_cents, inventory, shipping_days) values
  ('kb_hushline_96', 's_hushline', 'mechanical_keyboard', 'Hushline 96 Silent',
   '96% layout with numpad, silent linear switches, hot-swap, wireless.',
   '{"layout":"96%","switch":"silent linear","hot_swap":true,"wireless":true,"battery_hours":90,"numpad":true,"warranty":"2 years"}', 12400, 35, 6)
on conflict (id) do nothing;

insert into seller_policies (product_id, floor_price_cents, unit_cost_cents, target_margin_pct, max_rounds, allowed_concessions) values
  ('kb_hushline_96', 10200, 5800, 30, 4, '{free_shipping,bundle_discount}')
on conflict (product_id) do nothing;

-- Stated warranties (only where a product doesn't state one yet).
update products p set specs = p.specs || jsonb_build_object('warranty', w.warranty)
from (values
  ('kb_keyforge_quiet75', '1 year'),
  ('kb_clackco_tkl',      '2 years'),
  ('kb_typewell_65',      '1 year'),
  ('hp_keyforge_anc',     '1 year'),
  ('hp_clackco_studio',   '2 years'),
  ('hp_typewell_buds',    '1 year')
) as w(id, warranty)
where p.id = w.id and not (p.specs ? 'warranty');

commit;
