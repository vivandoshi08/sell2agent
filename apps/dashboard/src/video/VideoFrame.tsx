/**
 * /video: the framed stage for the three live segments of the demo video (see segments.ts).
 *   ?seg=negotiate|close|transact   which segment (default negotiate)
 *   ?mode=preview (default)         plays in real time with placeholder panes, for eyeballing in a browser
 *         bg                        stage, labels, chips, strip; panes in the surface colour (compose.sh lays recordings on them)
 *         fg                        transparent; only the highlight ring and the dim over the other pane (laid over the recordings)
 *         green                     the CapCut layout: like bg + ring, panes pure #00FF00 (no fade, so it always keys)
 *         mask                      white rounded rects (1 px larger than each pane) on black, for compose.sh
 *   ?t=12.5                         freeze at a time; render.mjs drives time with window.__seek(t)
 *   ?buyer=ChatGPT  ?cues=…  ?zoom=fx,fy,scale|off   overrides (see segments.ts)
 */
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Contours } from "../ui/Brand";
import { H, LOOK, SEGMENTS, W, easeOut, paneIn, pulse, ramp, withOverrides, type Chip, type PaneId, type SegId, type Segment } from "./segments";
import { COLD, ColdOpen } from "./ColdOpen";
import "../ui/fonts";
import "./video.css";

type Mode = "preview" | "bg" | "fg" | "green" | "mask";
const q = new URLSearchParams(location.search);
const isCold = q.get("seg") === "coldopen";
const segId = (q.get("seg") as SegId) in SEGMENTS ? (q.get("seg") as SegId) : "negotiate";
const mode: Mode = (["preview", "bg", "fg", "green", "mask"] as const).find((m) => m === q.get("mode")) ?? "preview";
const seg: Segment = withOverrides(SEGMENTS[segId], q);
const PANES: PaneId[] = ["left", "right"];
const DURATION = isCold ? COLD.duration : seg.duration;

declare global { interface Window { __seek?: (t: number) => void; __segment?: Segment; __ready?: boolean } }

function useTime(): number {
  const fixed = q.get("t");
  const [t, setT] = useState(fixed !== null ? Number(fixed) : 0);
  useEffect(() => {
    window.__seek = (v: number) => flushSync(() => setT(v));
    window.__segment = isCold ? ({ id: "coldopen", title: "Cold open", window: "0:00–0:07", duration: COLD.duration, panes: COLD.panes } as unknown as Segment) : seg;
    if (mode !== "preview" || fixed !== null) return;
    // Preview: loop the segment in real time, with a beat of black-free hold at the end.
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => { setT(((now - t0) / 1000) % (DURATION + 1)); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return Math.min(t, DURATION);
}

export function VideoFrame() {
  const t = useTime();
  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.classList.add("video-root", `video-${mode}`);
    document.fonts.ready.then(() => { window.__ready = true; });
  }, []);

  if (isCold) return <ColdOpen t={t} mode={mode} />;
  if (mode === "mask") return <MaskFrame />;

  const show = { stage: mode !== "fg", ring: mode !== "bg", dim: mode === "fg" || mode === "preview" };
  return (
    <div className="v-stage" style={{ width: W, height: H, background: show.stage ? LOOK.stage : "transparent" }}>
      {show.stage && <div className="v-contours-wrap"><Contours className="v-contours" /></div>}
      {PANES.map((p) => <PaneBox key={p} id={p} t={t} show={show} />)}
      {show.stage && PANES.map((p) => <Label key={p} id={p} t={t} />)}
      {show.stage && <Chips t={t} />}
      {show.stage && seg.steps && <Steps t={t} />}
      {mode === "preview" && <div className="v-timecode">{seg.title} · {seg.window} · {t.toFixed(1)}s / {seg.duration}s</div>}
    </div>
  );
}

function PaneBox({ id, t, show }: { id: PaneId; t: number; show: { stage: boolean; ring: boolean; dim: boolean } }) {
  const r = seg.panes[id];
  const { dx, opacity } = paneIn(t, id);
  const hl = seg.highlight.find((h) => h.pane === id);
  const ring = Math.max(0, ...seg.highlight.filter((h) => h.pane === id).map((h) => pulse(t, h.from, h.to)));
  const other = seg.dimOthers ? Math.max(0, ...seg.highlight.filter((h) => h.pane !== id).map((h) => pulse(t, h.from, h.to, 0.4))) : 0;
  const fill = mode === "green" ? LOOK.key : LOOK.pane;
  const fade = mode === "bg" || mode === "preview" ? opacity : 1; // green never fades, so it always keys
  const box = { left: r.x + dx, top: r.y, width: r.w, height: r.h };
  return (
    <>
      {show.stage && (
        <div className={`v-pane${mode === "green" ? " key" : ""}`} style={{ ...box, background: fill, opacity: fade }}>
          {mode === "preview" && (
            <div className="v-ph">
              <b>{id === "left" ? `${seg.labels.left.k}: ${seg.labels.left.v}` : `${seg.labels.right.k}: ${seg.labels.right.v}`}</b>
              <span>Record this window at {r.w * 2}×{r.h * 2} (2×)</span>
            </div>
          )}
        </div>
      )}
      {show.dim && other > 0 && <div className="v-dim" style={{ ...box, opacity: other * fade }} />}
      {show.ring && hl && ring > 0 && <div className="v-ring" style={{ ...box, opacity: ring * fade }} />}
    </>
  );
}

function Label({ id, t }: { id: PaneId; t: number }) {
  const r = seg.panes[id], l = seg.labels[id];
  const { dx, opacity } = paneIn(t, id);
  const lit = seg.highlight.some((h) => h.pane === id && t >= h.from && t < h.to);
  const sw = l.switchAt !== undefined ? ramp(t, l.switchAt, 0.3) : 0;
  const one = (k: string, v: string, o: number) => (
    <span className="v-label-in" style={{ opacity: o }}><i className={lit ? "lit" : ""} />{k}<em>·</em><b>{v}</b></span>
  );
  return (
    <div className="v-label" style={{ left: r.x + dx + 4, top: r.y - 44, opacity }}>
      {one(l.k, l.v, 1 - sw)}
      {l.switchAt !== undefined && one(l.k2 ?? l.k, l.v2 ?? l.v, sw)}
    </div>
  );
}

function ChipView({ c, t }: { c: Chip; t: number }) {
  const o = pulse(t, c.from, c.to);
  const lift = (1 - easeOut(ramp(t, c.from, 0.35))) * 10;
  const parts = c.mono ? c.text.split(c.mono) : [c.text];
  return (
    <span className="v-chip" style={{ opacity: o, transform: `translateY(${lift}px)` }}>
      {c.icon && <i className={`ic ${c.icon}`} />}
      <span>{c.mono ? <>{parts[0]}<code>{c.mono}</code>{parts[1]}</> : c.text}</span>
    </span>
  );
}

function Chips({ t }: { t: number }) {
  const row = seg.chips.filter((c) => c.at === "row");
  const top = Math.max(...PANES.map((p) => seg.panes[p].y + seg.panes[p].h)) + 40;
  return (
    <>
      {PANES.map((p) => {
        const mine = seg.chips.filter((c) => c.at === p);
        if (!mine.length) return null;
        const r = seg.panes[p];
        return (
          <div key={p} className="v-chips one" style={{ left: r.x, width: r.w, top }}>
            {mine.map((c, i) => <ChipView key={i} c={c} t={t} />)}
          </div>
        );
      })}
      {row.length > 0 && (
        <div className="v-chips row" style={{ left: 0, width: W, top }}>
          {row.map((c, i) => <ChipView key={i} c={c} t={t} />)}
        </div>
      )}
    </>
  );
}

function Steps({ t }: { t: number }) {
  const steps = seg.steps!;
  const left = seg.panes.left.x, right = seg.panes.right.x + seg.panes.right.w;
  const top = seg.panes.left.y + seg.panes.left.h + 40;
  const inO = ramp(t, 0.3, 0.4);
  return (
    <div className="v-steps" style={{ left, width: right - left, top, opacity: inO }}>
      {steps.map((s, i) => {
        const on = ramp(t, s.at, 0.35);
        const next = steps[i + 1];
        const done = next ? ramp(t, next.at, 0.35) : 0;
        const state = done >= 1 ? "done" : on > 0 ? "active" : "todo";
        return (
          <div key={i} className={`v-step ${state}`}>
            <span className="dot" style={{ ["--on" as string]: on }}>
              {done >= 1 || (i === steps.length - 1 && on >= 1) ? <svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg> : i + 1}
            </span>
            <span className="txt">{s.text}</span>
            {next && <span className="bar"><span style={{ transform: `scaleX(${easeOut(done)})` }} /></span>}
          </div>
        );
      })}
    </div>
  );
}

/** White rounded rects, 1 px larger than each pane so the mask's anti-aliased edge sits outside the pane fill. */
function MaskFrame() {
  return (
    <div style={{ position: "relative", width: W, height: H, background: "#000" }}>
      {PANES.map((p) => {
        const r = seg.panes[p];
        return <div key={p} style={{ position: "absolute", left: r.x - 1, top: r.y - 1, width: r.w + 2, height: r.h + 2, borderRadius: LOOK.radius + 1, background: "#fff" }} />;
      })}
    </div>
  );
}

