# Brief: apps/marketplace + supabase/seed.sql (Person C)

Others depend on you first. Read `/CLAUDE.md` and `packages/shared/src/index.ts` first.

**Hour 1 (unblocks everyone)**
- Create the shared Supabase project, run `supabase/migrations/0001_init.sql` and `supabase/seed.sql`, and post the keys in the group chat.
- Express server on port 3002: `GET /search` validates `SearchQuery` and returns `SearchResponse`. Listings join `products` and `sellers`. **Never include `seller_policies`.** Log a `search` event.

**Then**
- Expand the seed: 3–4 competing products per category with realistic specs, so buyers have real tradeoffs.
- Add a script that flips all sellers between `static` and `negotiating` (the eval runner needs this).
- Stretch: `GET /listing/:id`, and a `/.well-known/agent.json`-style discovery doc.

**Done when:** `curl localhost:3002/search?category=mechanical_keyboard` returns listings with `mcp_url`.
