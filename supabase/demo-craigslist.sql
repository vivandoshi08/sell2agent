-- Demo: the two real Craigslist keyboards the Grok personas shop between (additive, idempotent: safe to re-run).
-- Both list at $40, pickup in Potrero Hill. They differ in one way that matters for the demo:
--   kb_keychron_k2_real        s_potrero    policy 'learned':  a sell2agent seller (answers, haggles, follows up)
--   kb_lenovo_legion_k510_real s_potrero_b  policy 'static':   the same kind of listing without sell2agent (list price, fixed)
-- Personas: apps/dashboard/demo/PERSONAS.md. Never touches existing seller_policies rows.
-- Apply in the Supabase SQL editor, or: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/demo-craigslist.sql
begin;

insert into sellers (id, name, mcp_url, strategy) values
  ('s_potrero',   'Potrero Hill seller',   'https://dark-zero-mesv5.run.mcp-use.com/mcp', 'negotiating'),
  ('s_potrero_b', 'Potrero Hill seller B', 'https://dark-zero-mesv5.run.mcp-use.com/mcp', 'static')
on conflict (id) do nothing;

insert into products (id, seller_id, category, title, description, specs, list_price_cents, inventory, shipping_days) values
  ('kb_keychron_k2_real', 's_potrero', 'mechanical_keyboard', 'Keychron K2 (Version 2) wireless mechanical keyboard, Gateron Brown',
   'Keychron K2 (Version 2) wireless mechanical keyboard, Gateron Brown switches (tactile, quiet). 75% layout, 84 keys, aluminum frame. Bluetooth 5.1 (up to 3 devices) or wired USB-C. Mac and Windows keycaps included. Lightly used. No warranty (private sale). Pickup in Potrero Hill.',
   '{"make":"Keychron","model":"K2 (Version 2)","layout":"75%","keys":84,"switch":"Gateron Brown (tactile, quiet)","frame":"aluminum","wireless":true,"bluetooth":"5.1, up to 3 devices","wired":"USB-C","os":"Mac, Windows, iOS, Android","backlight":"RGB","battery_mah":4000,"battery_hours_rgb_on":72,"battery_hours_backlight_off":240,"in_box":"Mac and Windows keycaps, USB-C cable, keycap puller","condition":"excellent (lightly used)","warranty":"none (private sale)","weight_lb":1.75,"dimensions_in":"12.5 x 5.1 x 1.6","pickup":"Potrero Hill, SF"}',
   4000, 1, 0),
  ('kb_lenovo_legion_k510_real', 's_potrero_b', 'mechanical_keyboard', 'Lenovo Legion K510 Mini Pro mechanical keyboard, brown tactile switches',
   'Lenovo Legion K510 Mini Pro, brown tactile switches. 75% layout, 84 keys (US), hot-swappable switches, per-key RGB (Windows Dynamic Lighting). Wired USB-C only, braided 1.8 m USB-C to USB-A cable and keycap puller included. Windows 10 or later. Lightly used, works perfectly. No warranty (private sale). Pickup in Potrero Hill.',
   '{"make":"Lenovo","model":"Legion K510 Mini Pro","layout":"75%","keys":84,"switch":"brown (tactile)","hot_swap":true,"wireless":false,"wired":"USB-C (USB-C to USB-A cable)","backlight":"per-key RGB","os":"Windows 10 or later","in_box":"braided 1.8 m cable, keycap puller","condition":"excellent (lightly used)","warranty":"none (private sale)","weight_lb":1.5,"dimensions_in":"12.2 x 4.7 x 1.5","pickup":"Potrero Hill, SF"}',
   4000, 1, 0)
on conflict (id) do nothing;

insert into seller_policies (product_id, floor_price_cents, unit_cost_cents, target_margin_pct, max_rounds, allowed_concessions, policy) values
  ('kb_keychron_k2_real',        3000, 2000, 25, 6, '{}', 'learned'),
  ('kb_lenovo_legion_k510_real', 4000, 2000, 25, 6, '{}', 'static')
on conflict (product_id) do nothing;

commit;
