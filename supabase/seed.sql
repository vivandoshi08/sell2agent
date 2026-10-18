-- Catalog seed (S1). One multi-tenant seller MCP server; each seller has its own path.
-- Four competing keyboard sellers, each with a stated warranty in specs (trust-first buyers ask for one).
-- Mirrors: apps/marketplace/src/catalog.ts (gateway fallback) and apps/seller-mcp/src/exchange/catalog.ts (E1 seed).
-- Already-loaded databases: apply supabase/catalog-expand.sql instead (additive, keeps console edits).

insert into sellers (id, name, mcp_url, strategy) values
  ('s_keyforge', 'KeyForge',     'http://localhost:3001/mcp/s_keyforge', 'negotiating'),
  ('s_clackco',  'ClackCo',      'http://localhost:3001/mcp/s_clackco',  'negotiating'),
  ('s_typewell', 'TypeWell',     'http://localhost:3001/mcp/s_typewell', 'negotiating'),
  ('s_hushline', 'Hushline',     'http://localhost:3001/mcp/s_hushline', 'negotiating');

insert into products (id, seller_id, category, title, description, specs, list_price_cents, inventory, shipping_days) values
  ('kb_keyforge_quiet75', 's_keyforge', 'mechanical_keyboard', 'KeyForge Quiet 75',
   '75% layout, silent linear switches, hot-swap, wireless.',
   '{"layout":"75%","switch":"silent linear","hot_swap":true,"wireless":true,"battery_hours":200,"warranty":"1 year"}', 12900, 40, 3),
  ('kb_clackco_tkl', 's_clackco', 'mechanical_keyboard', 'ClackCo TKL Pro',
   'Tenkeyless, tactile switches, aluminum case, wired.',
   '{"layout":"TKL","switch":"tactile","hot_swap":false,"wireless":false,"warranty":"2 years"}', 11500, 25, 5),
  ('kb_typewell_65', 's_typewell', 'mechanical_keyboard', 'TypeWell 65 Silent',
   '65% compact, silent tactile switches, wireless, hot-swap.',
   '{"layout":"65%","switch":"silent tactile","hot_swap":true,"wireless":true,"battery_hours":120,"warranty":"1 year"}', 13900, 60, 2),
  ('kb_hushline_96', 's_hushline', 'mechanical_keyboard', 'Hushline 96 Silent',
   '96% layout with numpad, silent linear switches, hot-swap, wireless.',
   '{"layout":"96%","switch":"silent linear","hot_swap":true,"wireless":true,"battery_hours":90,"numpad":true,"warranty":"2 years"}', 12400, 35, 6),
  ('hp_keyforge_anc', 's_keyforge', 'headphones', 'KeyForge ANC Over-Ear',
   'Active noise cancelling, 40h battery, USB-C.',
   '{"anc":true,"battery_hours":40,"wireless":true,"warranty":"1 year"}', 19900, 30, 3),
  ('hp_clackco_studio', 's_clackco', 'headphones', 'ClackCo Studio Wired',
   'Open-back studio headphones, wired, 250 ohm.',
   '{"anc":false,"wireless":false,"impedance_ohm":250,"warranty":"2 years"}', 14900, 15, 4),
  ('hp_typewell_buds', 's_typewell', 'headphones', 'TypeWell ANC Buds',
   'In-ear ANC earbuds, 8h battery, wireless charging case.',
   '{"anc":true,"battery_hours":8,"wireless":true,"warranty":"1 year"}', 12900, 80, 2);

insert into seller_policies (product_id, floor_price_cents, unit_cost_cents, target_margin_pct, max_rounds, allowed_concessions) values
  ('kb_keyforge_quiet75', 10500, 6000, 35, 4, '{free_shipping,volume_discount}'),
  ('kb_clackco_tkl',      9500,  5500, 30, 3, '{free_shipping}'),
  ('kb_typewell_65',      11000, 6500, 35, 4, '{free_shipping,extended_warranty}'),
  ('kb_hushline_96',      10200, 5800, 30, 4, '{free_shipping,bundle_discount}'),
  ('hp_keyforge_anc',     16000, 9000, 35, 4, '{free_shipping,extended_warranty}'),
  ('hp_clackco_studio',   12000, 7000, 30, 3, '{free_shipping}'),
  ('hp_typewell_buds',    10000, 5000, 40, 4, '{free_shipping,bundle_discount}');
