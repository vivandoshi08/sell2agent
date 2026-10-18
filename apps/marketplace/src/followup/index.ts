// Bridge 3 follow-up loop on the gateway: couriers (Inkbox, log fallback), the door's HTTP routes, and the dev timer.
//
// Env (all optional; without any of them follow-ups go to the log courier and need the timer or the cron route):
//   FOLLOWUP_DELAY_MS   wait after a consented walk-away (default 1 h; demo: 60000). Read by E1's outreach.
//   OUTREACH_SECRET     bearer for POST /cron/outreach, plain-JSON POST /inbound/:channel and GET /outbox
//   OUTREACH_TICK_MS    runDue() timer; default 15000 unless NODE_ENV=production; 0 turns it off
//   INKBOX_API_KEY      turns Inkbox on; plus INKBOX_MAILBOX / INKBOX_PHONE_NUMBER_ID, or INKBOX_IDENTITY to look them up
//   INKBOX_SIGNING_KEY  verifies Inkbox webhooks on /inbound/:channel (or give the subscription auth_token = OUTREACH_SECRET)
import type { Exchange } from "@sa/seller-mcp/exchange";
import { asSender, courierFromEnv, type FallbackCourier } from "./couriers";
import { createFollowupDoor, type DoorDeps, type HttpIn, type HttpOut } from "./door";

export { LogCourier, InkboxCourier, FallbackCourier, courierFromEnv, asSender } from "./couriers";
export type { Courier, Outgoing, OutboxEntry, FollowupChannel, InkboxConfig } from "./couriers";
export { createFollowupDoor, replyText, REPLY_BUDGET } from "./door";
export type { DoorDeps, HttpIn, HttpOut } from "./door";
export { parseInboundRequest, verifyInkboxSignature, authorize } from "./inbound";

let courier: FallbackCourier | undefined;
/** One courier per process: the exchange's follow-ups, the door's replies and /outbox share its log outbox. */
export const followupCourier = () => (courier ??= courierFromEnv());
export const followupSender = () => asSender(followupCourier());

// biome-ignore lint: server type comes from mcp-use (Hono context)
export function registerFollowups(server: any, deps: DoorDeps) {
  const door = createFollowupDoor(deps);
  const toIn = async (c: any): Promise<HttpIn> => ({
    params: { channel: c.req.param?.("channel") },
    query: new URL(c.req.url).searchParams,
    headers: (name: string) => c.req.header(name) ?? undefined,
    body: await c.req.text(),
  });
  const send = (o: HttpOut) => new Response(o.body, { status: o.status, headers: o.headers });
  const route = (h: (r: HttpIn) => Promise<HttpOut>) => async (c: any) => {
    try {
      return send(await h(await toIn(c)));
    } catch (e) {
      console.error("[followup]", (e as Error).message);
      return send({ status: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: false, error: "follow-up door failed" }) });
    }
  };
  server.post("/cron/outreach", route(door.cron));
  server.post("/inbound/:channel", route(door.inbound));
  server.get("/outbox", route(door.outbox));
  return door;
}

/** Calls runDue() every OUTREACH_TICK_MS. Returns a stop function, or null when off. */
export function startOutreachTimer(exchange: () => Promise<Exchange>, env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  const ms = env.OUTREACH_TICK_MS !== undefined && env.OUTREACH_TICK_MS !== "" ? Number(env.OUTREACH_TICK_MS) : env.NODE_ENV === "production" ? 0 : 15_000;
  if (!(ms > 0)) return null;
  const t = setInterval(() => {
    exchange()
      .then((ex) => ex.outreach.runDue())
      .then((sent) => { if (sent.length) console.log(`[followup] sent ${sent.length} follow-up(s)`); })
      .catch((e: Error) => console.error("[followup] runDue failed", e.message));
  }, ms);
  t.unref?.();
  return () => clearInterval(t);
}
