/**
 * Bundled face (SIL OFL 1.1, see fonts/OFL.txt): Instrument Sans for the whole UI. Inlined as data URIs so the
 * dashboard and the single-file preview look the same with no network. Numbers use its tabular figures.
 */
import is400 from "./fonts/instrument-sans-latin-400-normal.woff2?inline";
import is500 from "./fonts/instrument-sans-latin-500-normal.woff2?inline";
import is600 from "./fonts/instrument-sans-latin-600-normal.woff2?inline";

const faces: [string, number][] = [[is400, 400], [is500, 500], [is600, 600]];

if (typeof document !== "undefined" && !document.getElementById("sa-fonts")) {
  const style = document.createElement("style");
  style.id = "sa-fonts";
  style.textContent = faces
    .map(([src, weight]) => `@font-face{font-family:"Instrument Sans";src:url(${src}) format("woff2");font-weight:${weight};font-style:normal;font-display:swap}`)
    .join("\n");
  document.head.appendChild(style);
}
