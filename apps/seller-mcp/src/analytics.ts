// Armature MCP analytics for the seller MCP server.
// Docs: docs/tracks/armature.md. Keys: ANALYTICS_INGEST_API_KEY in /.env
//
// Usage — wrap the factory that builds your McpServer, instead of newing it directly:
//
//   import { buildAnalyticsServer, flushAnalytics } from "./analytics.js";
//
//   const server = buildAnalyticsServer(() => {
//     const mcp = new McpServer({ name: "seller-mcp", version: "0.1.0" });
//     registerTools(mcp);          // tools registered inside the factory
//     return mcp;
//   });
//   await server.connect(transport);
//
// With no ANALYTICS_INGEST_API_KEY set, this returns the plain server and
// sends nothing — so local dev and CI work without an Armature workspace.

import { createMcpAnalyticsServer } from "@armature-tech/mcp-analytics";

type ServerFactory<T> = () => T;

export const analyticsEnabled = (): boolean =>
  Boolean(process.env.ANALYTICS_INGEST_API_KEY);

export interface AnalyticsOptions {
  /** "await" before responding — use on serverless/edge deploys. */
  delivery?: "background" | "await";
  /** Set false to drop the injected request_capability tool from the surface. */
  requestCapability?: boolean;
  /** Set false to keep call analytics but drop conversation-derived telemetry. */
  captureTelemetry?: boolean;
  timeoutMs?: number;
}

export function buildAnalyticsServer<T>(
  factory: ServerFactory<T>,
  options: AnalyticsOptions = {},
): T {
  if (!analyticsEnabled()) {
    console.warn("[analytics] ANALYTICS_INGEST_API_KEY unset — Armature capture off");
    return factory();
  }

  return createMcpAnalyticsServer(factory as never, {
    armature: {
      apiKey: process.env.ANALYTICS_INGEST_API_KEY,
      endpointUrl: process.env.ANALYTICS_INGEST_URL,
      delivery: options.delivery ?? "background",
      timeoutMs: options.timeoutMs ?? 5000,
      requestCapability: options.requestCapability ?? true,
      captureTelemetry: options.captureTelemetry ?? true,
      // Never silent: delivery failures are logged, never thrown into a tool call.
      onError: (error: unknown) =>
        console.warn("[analytics] delivery failed", error),
    },
  }) as T;
}

/** Call on SIGTERM/SIGINT so background-delivered events aren't lost. */
export async function flushAnalytics(server: unknown): Promise<void> {
  const recorder = (server as { recorder?: { flush?: () => Promise<void> } })
    ?.recorder;
  if (!recorder?.flush) return;
  try {
    await recorder.flush();
  } catch (error) {
    console.warn("[analytics] flush failed", error);
  }
}
