/**
 * Bundled faces (SIL OFL 1.1, see fonts/OFL.txt). Inlined as data URIs so the dashboard and the
 * single-file preview render the same with no network: Doto (dot-matrix) for display numbers,
 * Martian Mono for everything else. Fallbacks are system monospace.
 */
import doto800 from "./fonts/doto-latin-800-normal.woff2?inline";
import doto900 from "./fonts/doto-latin-900-normal.woff2?inline";
import mm400 from "./fonts/martian-mono-latin-400-normal.woff2?inline";
import mm500 from "./fonts/martian-mono-latin-500-normal.woff2?inline";
import mm600 from "./fonts/martian-mono-latin-600-normal.woff2?inline";

const faces: [string, string, number][] = [
  ["Doto", doto800, 800], ["Doto", doto900, 900],
  ["Martian Mono", mm400, 400], ["Martian Mono", mm500, 500], ["Martian Mono", mm600, 600],
];

if (typeof document !== "undefined" && !document.getElementById("sa-fonts")) {
  const style = document.createElement("style");
  style.id = "sa-fonts";
  style.textContent = faces
    .map(([family, src, weight]) => `@font-face{font-family:"${family}";src:url(${src}) format("woff2");font-weight:${weight};font-style:normal;font-display:swap}`)
    .join("\n");
  document.head.appendChild(style);
}
