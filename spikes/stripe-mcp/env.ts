/** Load the Stripe key read-only from an .env file (default: the main checkout). TEST MODE ONLY. Never prints the key. */
import { readFileSync } from "node:fs";

const ENV_PATH = process.env.SPIKE_ENV_PATH ?? "/Users/vivandoshi/Documents/hackathons/sales-agent/.env";

export function testKey(): string {
  let key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const line = readFileSync(ENV_PATH, "utf8").split("\n").find((l) => l.startsWith("STRIPE_SECRET_KEY="));
    key = line?.slice("STRIPE_SECRET_KEY=".length).trim().replace(/^["']|["']$/g, "");
  }
  if (!key || !/^(sk|rk)_test_/.test(key)) throw new Error("refusing: STRIPE_SECRET_KEY missing or not a TEST key (sk_test_/rk_test_)");
  return key;
}
