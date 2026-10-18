// Armature MCP Analytics on the live gateway: every tool call real agents make (ChatGPT, Claude, Armature's own
// testers, Instinct) is recorded in the Armature workspace, with its client, duration, ok/error and a result preview.
// Armature evals test the gateway from outside on a schedule; this shows what agents actually do between evals.
//
// mcp-use isn't on the SDK's list of wrapped server shapes, so this wraps `server.tool` itself: every handler
// registered after instrumentGateway() runs inside recorder.instrumentToolCall(). Nothing about the tool surface
// changes (no telemetry field, no extra request_capability tool), so agents see exactly the same tools.
//
// Off unless ANALYTICS_INGEST_API_KEY is set; a failed send is logged and never fails a tool call.
import { createAnalyticsRecorder } from "@armature-tech/mcp-analytics";

type Ctx = {
  client?: { info?: () => { name?: string; version?: string } | undefined };
  session?: { sessionId?: string; id?: string };
  sessionId?: string;
  requestId?: string | number;
};

export const armatureEnabled = (): boolean => Boolean(process.env.ANALYTICS_INGEST_API_KEY);

/** Fields worth seeing per call in Armature; never prices beyond what the agent itself sent. */
function metadataOf(args: unknown): Record<string, unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  const pick = ["run_id", "product_id", "negotiation_id", "deal_id", "channel"] as const;
  return Object.fromEntries(pick.filter((k) => typeof a[k] === "string").map((k) => [k, a[k]]));
}

// biome-ignore lint: server type comes from mcp-use
export function instrumentGateway(server: any): { flush: () => Promise<void> } | null {
  if (!armatureEnabled()) {
    console.warn("[armature] ANALYTICS_INGEST_API_KEY unset: live tool-call analytics off");
    return null;
  }
  const recorder = createAnalyticsRecorder({
    armature: {
      apiKey: process.env.ANALYTICS_INGEST_API_KEY,
      // .env.example ships ANALYTICS_INGEST_URL= (blank = US); the SDK would read that blank as the URL, so default it here
      endpointUrl: process.env.ANALYTICS_INGEST_URL || "https://app.armature.tech/api/mcp-analytics/ingest",
      delivery: "background",
      captureTelemetry: false,
      onError: (e) => {
        const err = e as Error & { cause?: { message?: string } };
        console.error("[armature] ingest failed", err?.message ?? e, err?.cause?.message ?? "");
      },
    },
  });
  const original = server.tool.bind(server);
  // biome-ignore lint: mcp-use handler signature
  server.tool = (def: { name: string }, handler: (args: any, ctx?: Ctx) => unknown) =>
    original(def, (args: unknown, ctx?: Ctx) => {
      const info = ctx?.client?.info?.();
      const sessionId = ctx?.session?.sessionId ?? ctx?.session?.id ?? ctx?.sessionId;
      return recorder.instrumentToolCall(
        {
          name: def.name,
          args,
          ...(sessionId ? { sessionId } : {}),
          ...(ctx?.requestId !== undefined ? { requestId: String(ctx.requestId) } : {}),
          ...(info?.name ? { clientInfo: { name: info.name, version: info.version ?? "" } } : {}),
          metadataExtra: metadataOf(args),
        },
        () => handler(args, ctx),
      );
    });
  console.log("[armature] live tool-call analytics on");
  return { flush: () => recorder.flush() };
}
