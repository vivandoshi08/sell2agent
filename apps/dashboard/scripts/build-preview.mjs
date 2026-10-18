// Builds the dashboard (sample-data mode) into ONE self-contained HTML file: dist/preview.html.
// Use it to share or publish a preview (e.g. as a claude.ai artifact) without running a server.
//   pnpm --filter @sa/dashboard preview:html
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
// No Supabase env → the app falls back to labelled sample data.
execSync("vite build", { cwd: root, stdio: "inherit", env: { ...process.env, SUPABASE_URL: "", SUPABASE_ANON_KEY: "" } });
const assets = join(root, "dist", "assets");
const files = readdirSync(assets);
const css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(assets, f), "utf8")).join("\n");
const js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(assets, f), "utf8")).join("\n").replaceAll("</script", "<\\/script");
const fonts = readFileSync(join(root, "index.html"), "utf8").match(/<link rel="stylesheet"[^>]+>/)?.[0] ?? "";
const html = `<title>Negotiation Proof Preview</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>${css}</style>
<div id="root"></div>
<script type="module">${js}</script>
`;
writeFileSync(join(root, "dist", "preview.html"), html);
console.log(`Wrote dist/preview.html (${Math.round(html.length / 1024)} KB)`);
