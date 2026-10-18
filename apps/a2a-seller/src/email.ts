/**
 * SPIKE: the seller as an email agent on Primitive (primitive.dev). Deployable as a Primitive Function
 * (`export default { fetch }`, bound to e.g. sell@<name>.primitive.email) or any webhook endpoint.
 * Inbound email → (verify signature) → SellerAgent.text() → client.reply() in the same thread.
 * Buyer identity = the From address, marked verified only when DMARC passes and aligns with the From domain.
 */
import { createPrimitiveClient, normalizeReceivedEmail, verifyWebhookSignature, PRIMITIVE_SIGNATURE_HEADER } from "@primitivedotdev/sdk/api";
import type { EmailReceivedEvent } from "@primitivedotdev/sdk/webhook";
import { SellerAgent } from "./agent";

export interface ReplyPort { reply(email: ReturnType<typeof normalizeReceivedEmail>, input: { text: string }): Promise<unknown> }

/** The buyer, as far as email can vouch for them. */
export function emailIdentity(ev: EmailReceivedEvent): { buyer_id: string; verified: boolean; address: string } {
  const address = (ev.email.headers.from.match(/<([^>]+)>/)?.[1] ?? ev.email.headers.from).trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";
  const a = ev.email.auth;
  const verified = a?.dmarc === "pass" && !!a.dmarcFromDomain && domain === a.dmarcFromDomain.toLowerCase();
  return { buyer_id: `${verified ? "email" : "anon_email"}_${address}`, verified, address };
}

export async function handleEmailEvent(agent: SellerAgent, ev: EmailReceivedEvent, port: ReplyPort) {
  if (ev.event !== "email.received") return { skipped: true };
  const email = normalizeReceivedEmail(ev);
  const id = emailIdentity(ev);
  const key = ev.email.thread_id ?? id.address; // one negotiation per thread
  const body = email.text ?? "";
  const { reply, data } = await agent.text(key, `${email.subject ?? ""}\n${body}`, id.buyer_id);
  await port.reply(email, { text: reply });
  return { ok: true, buyer: id, reply, data };
}

/** Primitive Function / webhook entrypoint. */
const agent = new SellerAgent(undefined, { channel: "messaging", operator: "email" });
export default {
  async fetch(request: Request, env: { PRIMITIVE_API_KEY: string; PRIMITIVE_WEBHOOK_SECRET: string }): Promise<Response> {
    const rawBody = await request.text();
    try {
      verifyWebhookSignature({ rawBody, signatureHeader: request.headers.get(PRIMITIVE_SIGNATURE_HEADER) ?? "", secret: env.PRIMITIVE_WEBHOOK_SECRET });
    } catch {
      return new Response("bad signature", { status: 401 });
    }
    const client = createPrimitiveClient({ apiKey: env.PRIMITIVE_API_KEY });
    const out = await handleEmailEvent(agent, JSON.parse(rawBody) as EmailReceivedEvent, client as unknown as ReplyPort);
    return Response.json(out);
  },
};
