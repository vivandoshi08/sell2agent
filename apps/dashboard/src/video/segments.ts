/**
 * The three live segments of the 2:00 demo video (Esha's part). One source of truth for layout and timing:
 * the /video page draws from it, render.mjs exports it to out/<seg>/coords.json, and compose.sh reads that.
 *
 * Canvas 1920×1080 @ 30 fps. Times are seconds from the start of the segment's own clip.
 * Cue times are first guesses from the scripted voiceover; nudge them here (or pass ?cues= / CUES=) once the VO is recorded.
 */

export const W = 1920, H = 1080, FPS = 30;

/** Look shared with Ananya's clips. Stage and pane colours are the dashboard's dark tokens. */
export const LOOK = {
  stage: "#0b0d0c", pane: "#121413", line: "#232725", ink: "#eef0ee", muted: "#959b97", brand: "#5fc497", key: "#00ff00",
  radius: 20,
  /** Pane slide-in after the hard cut from a title card: ≤0.6 s, ease-out cubic, plus a linear fade (bg layer only). */
  slideIn: { dur: 0.55, dx: 48 },
};

export type SegId = "negotiate" | "close" | "transact";
export type PaneId = "left" | "right";
export interface Rect { x: number; y: number; w: number; h: number }
export interface Window { from: number; to: number }

export interface Chip {
  text: string;
  /** Where it sits: under one pane, or in the centred row under both. */
  at: PaneId | "row";
  from: number;
  to?: number;
  icon?: "link" | "shield" | "check";
  mono?: string; // part of the text to set in mono (e.g. a tool or error name)
}

export interface Segment {
  id: SegId;
  title: string; // for filenames and the browser preview only; not drawn
  window: string; // where it sits in the 2:00 cut
  duration: number;
  panes: Record<PaneId, Rect>;
  labels: Record<PaneId, { k: string; v: string; switchAt?: number; v2?: string; k2?: string }>;
  /** Green ring on the pane the voiceover is about. */
  highlight: (Window & { pane: PaneId })[];
  /** Dim the other pane while one is highlighted (drawn on the fg layer, over the recording). */
  dimOthers: boolean;
  chips: Chip[];
  /** Close only: the 4-step strip and when each step lights up. */
  steps?: { text: string; at: number }[];
  /** Optional slow zoom into one recording, e.g. the negotiation card. Focus is a fraction of the recording. */
  zoom?: { pane: PaneId; from: number; ramp: number; scale: number; fx: number; fy: number };
}

// Split layout: two 880×800 panes (aspect 1.1), labels above, chips / strip below.
const M = 64, GUT = 32, PW = (W - 2 * M - GUT) / 2, PY = 112, PH = 800;
const split: Record<PaneId, Rect> = {
  left: { x: M, y: PY, w: PW, h: PH },
  right: { x: M + PW + GUT, y: PY, w: PW, h: PH },
};

export const SEGMENTS: Record<SegId, Segment> = {
  negotiate: {
    id: "negotiate", title: "Negotiate", window: "0:23–0:51", duration: 28,
    panes: split,
    labels: { left: { k: "Buyer agent", v: "Grok" }, right: { k: "Seller dashboard", v: "Live" } },
    highlight: [{ pane: "left", from: 0, to: 14 }, { pane: "right", from: 14, to: 28 }],
    dimOthers: true,
    chips: [
      { text: "dark-zero-mesv5.run.mcp-use.com/mcp · hosted on Manufact", mono: "dark-zero-mesv5.run.mcp-use.com/mcp", at: "left", from: 0.7, to: 14, icon: "link" },
      { text: "Floor enforced in code · every move logged with its reason", at: "right", from: 14, to: 28, icon: "shield" },
    ],
    zoom: { pane: "right", from: 15, ramp: 1.4, scale: 1.35, fx: 0.5, fy: 0.4 },
  },
  close: {
    id: "close", title: "Close", window: "0:53–1:07", duration: 14,
    panes: split,
    labels: { left: { k: "Buyer", v: "Inbox" }, right: { k: "Seller dashboard", v: "Live" } },
    highlight: [],
    dimOthers: false,
    chips: [],
    steps: [
      { text: "Walked away", at: 0.8 },
      { text: "Follow-up via Inkbox", at: 3.2 },
      { text: "Reply ACCEPT", at: 11.0 },
      { text: "Deal locked", at: 12.8 },
    ],
  },
  transact: {
    id: "transact", title: "Transact", window: "1:09–1:29", duration: 20,
    panes: split,
    labels: {
      left: { k: "Buyer agent", v: "ChatGPT" },
      right: { k: "Seller dashboard", v: "Live", switchAt: 13, k2: "Stripe", v2: "Test mode" },
    },
    highlight: [{ pane: "left", from: 0, to: 9 }, { pane: "right", from: 9, to: 20 }],
    dimOthers: false,
    chips: [
      { text: "Signed deal", at: "row", from: 3.0, icon: "check" },
      { text: "Person approves the exact amount", at: "row", from: 6.0, icon: "check" },
      { text: "Charged once (retry returns already_paid)", mono: "already_paid", at: "row", from: 9.5, icon: "check" },
      { text: "No other buyer can pay it", at: "row", from: 12.0, icon: "check" },
      { text: "Stripe test mode", at: "row", from: 17.5, icon: "check" },
    ],
  },
};

/** Optional overrides from the URL (?buyer=ChatGPT&cues=3,6,9.5,12,17.5). Cues map onto chips, or steps for close. */
export function withOverrides(seg: Segment, q: URLSearchParams): Segment {
  const s: Segment = JSON.parse(JSON.stringify(seg));
  const buyer = q.get("buyer");
  if (buyer && s.labels.left.k === "Buyer agent") s.labels.left.v = buyer;
  const cues = (q.get("cues") ?? "").split(",").map(Number).filter((n) => Number.isFinite(n));
  if (cues.length) {
    if (s.steps) cues.forEach((c, i) => { if (s.steps![i]) s.steps![i].at = c; });
    else cues.forEach((c, i) => { if (s.chips[i]) s.chips[i].from = c; });
    // Negotiate: the pane switch follows the second chip.
    if (s.id === "negotiate" && cues[1] !== undefined) {
      s.chips[0].to = cues[1];
      s.highlight[0].to = cues[1];
      s.highlight[1].from = cues[1];
      if (s.zoom) s.zoom.from = cues[1] + 1;
    }
  }
  const zoom = q.get("zoom");
  if (zoom === "off") delete s.zoom;
  else if (zoom && s.zoom) {
    const [fx, fy, scale] = zoom.split(",").map(Number);
    if (Number.isFinite(fx)) s.zoom.fx = fx;
    if (Number.isFinite(fy)) s.zoom.fy = fy;
    if (Number.isFinite(scale)) s.zoom.scale = scale;
  }
  return s;
}

export const easeOut = (p: number) => 1 - Math.pow(1 - Math.min(Math.max(p, 0), 1), 3);
export const ramp = (t: number, from: number, dur: number) => Math.min(Math.max((t - from) / dur, 0), 1);
/** Fade in at `from`, out at `to`, over `d` seconds. */
export const pulse = (t: number, from: number, to: number | undefined, d = 0.35) =>
  Math.min(ramp(t, from, d), to === undefined ? 1 : 1 - ramp(t, to - d, d));

/** Pane offset and opacity during the slide-in; compose.sh uses the same curve for the recordings. */
export function paneIn(t: number, pane: PaneId) {
  const p = easeOut(t / LOOK.slideIn.dur);
  const dir = pane === "left" ? -1 : 1;
  return { dx: dir * LOOK.slideIn.dx * (1 - p), opacity: Math.min(t / LOOK.slideIn.dur, 1) };
}
