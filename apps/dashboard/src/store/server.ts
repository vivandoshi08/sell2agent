/**
 * Builds the My store API for the dev server. Loaded by vite.config.ts through ssrLoadModule, so it runs in Node
 * only: Stripe secrets and the service-role key never reach the browser.
 */
import { createClient } from "@supabase/supabase-js";
import { storeApi, type StoreDeps, type StoreListing } from "./api";

// @sa/payments reads process.env; Vite's loadEnv doesn't populate it, so copy just the keys it uses.
const PAYMENT_ENV = ["STRIPE_SECRET_KEY", "STRIPE_CONNECT", "PICKUP_HOLD", "PICKUP_SECRET", "EXCHANGE_HMAC_SECRET", "PLATFORM_FEE_BPS"];

export async function makeStoreApi(env: Record<string, string | undefined>) {
  for (const k of PAYMENT_ENV) if (env[k] !== undefined && process.env[k] === undefined) process.env[k] = env[k];
  const payments = await import("@sa/payments");
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  const db = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;

  const deps: StoreDeps = {
    async seller(id) {
      if (!db) return { id, name: id };
      const { data } = await db.from("sellers").select("id,name").eq("id", id).maybeSingle();
      return data ? { id: data.id, name: data.name } : null;
    },
    async listings(seller_id) {
      if (!db) return [];
      const { data: prods } = await db.from("products").select("id,title,list_price_cents,inventory").eq("seller_id", seller_id);
      const ids = (prods ?? []).map((p) => p.id);
      // The seller's own floor, shown only to them on their own page.
      const { data: pols } = ids.length ? await db.from("seller_policies").select("product_id,floor_price_cents").in("product_id", ids) : { data: [] };
      const floor = new Map((pols ?? []).map((p) => [p.product_id, p.floor_price_cents as number]));
      return (prods ?? []).map((p): StoreListing => ({ id: p.id, title: p.title, list_price_cents: p.list_price_cents,
        floor_price_cents: floor.get(p.id) ?? null, in_stock: (p.inventory ?? 0) > 0 }));
    },
    payments,
  };
  return { handler: storeApi(deps) };
}
