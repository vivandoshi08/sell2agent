import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { PORTS } from "@sa/shared";

// Reads the repo-root .env, but exposes ONLY the Supabase URL and anon key to the browser.
// Never widen this: the root .env also holds the service-role key and Stripe secrets.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../../", "");
  return {
    plugins: [react()],
    envPrefix: "VITE_DASHBOARD_", // nothing in .env uses this prefix, so nothing leaks by accident
    define: {
      "import.meta.env.SA_SUPABASE_URL": JSON.stringify(env.SUPABASE_URL ?? ""),
      "import.meta.env.SA_SUPABASE_ANON_KEY": JSON.stringify(env.SUPABASE_ANON_KEY ?? ""),
    },
    server: { port: Number(env.DASHBOARD_PORT) || PORTS.dashboard, strictPort: true },
  };
});
