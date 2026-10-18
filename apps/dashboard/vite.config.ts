import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { PORTS } from "@sa/shared";

// Merchant console API on the dev server (/api/console/*). Runs in Node via ssrLoadModule, so the
// service-role key stays server-side; the browser only ever calls these routes.
function consoleApi(env: Record<string, string>): Plugin {
  return {
    name: "sa-console-api",
    configureServer(server) {
      let api: Promise<{ store: string; handler: (req: any, res: any, next: () => void) => Promise<void> }> | null = null;
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/console/")) return next();
        api ??= server.ssrLoadModule("/src/console/server.ts").then((m) => {
          const a = m.makeConsoleApi(env);
          server.config.logger.info(`  merchant console: ${a.store} store`);
          return a;
        });
        api.then((a) => a.handler(req, res, next)).catch((e) => { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); });
      });
    },
  };
}

// Reads the repo-root .env, but exposes ONLY the Supabase URL and anon key to the browser.
// Never widen this: the root .env also holds the service-role key and Stripe secrets.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../../", "");
  return {
    plugins: [react(), consoleApi(env)],
    envPrefix: "VITE_DASHBOARD_", // nothing in .env uses this prefix, so nothing leaks by accident
    define: {
      "import.meta.env.SA_SUPABASE_URL": JSON.stringify(env.SUPABASE_URL ?? ""),
      "import.meta.env.SA_SUPABASE_ANON_KEY": JSON.stringify(env.SUPABASE_ANON_KEY ?? ""),
    },
    server: { port: Number(env.DASHBOARD_PORT) || PORTS.dashboard, strictPort: true },
  };
});
