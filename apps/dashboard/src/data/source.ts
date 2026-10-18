/**
 * Where events come from. Live: Supabase `events` (initial load + realtime inserts).
 * Sample: fake events replayed over time so the feed moves, labelled "Sample data" in the UI.
 * The browser only ever gets SUPABASE_URL and the anon key (see vite.config.ts).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NegotiationEvent } from "@sa/shared";
import { fakeComparison, fakeFollowups } from "./fake";

export type Mode = "live" | "local" | "sample";
export interface Feed {
  mode: Mode;
  /** What the data badge says, e.g. "Live · Supabase", "Eval run · eval_2310", "Sample data". */
  label: string;
  /** Calls back with the full event list whenever it grows. Returns an unsubscribe. */
  start(onEvents: (all: NegotiationEvent[]) => void, onError: (msg: string) => void): () => void;
}

/** E1 stores exchange state as rows in `events` (run_id "exchange_state", type "exchange_snapshot"). They aren't buyer activity. */
export function isActivity(e: NegotiationEvent): boolean {
  return e.run_id !== "exchange_state" && (e.type as string) !== "exchange_snapshot";
}

const URL_ = import.meta.env.SA_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.SA_SUPABASE_ANON_KEY as string | undefined;

/**
 * Live Supabase when keys are set; `?local` shows the latest S2 eval run saved by `pnpm --filter @sa/dashboard eval`
 * (public/runs/latest.json); `?sample` or nothing else available → labelled sample data.
 */
export function pickFeed(): Feed {
  const q = new URLSearchParams(location.search);
  if (q.has("sample")) return sampleFeed();
  if (q.has("local") || "__SA_EVAL__" in globalThis) return localFeed(q.get("local") || "latest");
  return URL_ && KEY ? liveFeed(URL_, KEY) : sampleFeed();
}

function localFeed(which: string): Feed {
  const feed: Feed = {
    mode: "local",
    label: "Eval run",
    start(onEvents, onError) {
      let stopped = false;
      (async () => {
        try {
          // A single-file preview (preview:html --local) embeds the run instead of fetching it.
          const embedded = (globalThis as { __SA_EVAL__?: { eval_id: string; events: NegotiationEvent[] } }).__SA_EVAL__;
          if (embedded) { feed.label = `Eval run · ${embedded.eval_id}`; if (!stopped) onEvents(embedded.events.filter(isActivity)); return; }
          const manifest = await (await fetch(`./runs/${which === "latest" ? "latest" : which}.json`)).json();
          const file = manifest.events ?? `${which}.events.json`;
          feed.label = `Eval run · ${manifest.eval_id ?? which}`;
          const events = (await (await fetch(`./runs/${file}`)).json()) as NegotiationEvent[];
          if (!stopped) onEvents(events.filter(isActivity));
        } catch {
          onError("No saved eval run found. Run `pnpm --filter @sa/dashboard eval` first, then reload with ?local.");
        }
      })();
      return () => { stopped = true; };
    },
  };
  return feed;
}

// Supabase's API returns at most 1000 rows per request whatever .limit() says, so the initial load pages.
// Oldest first, so rows inserted while it pages land after the last page instead of shifting the pages.
const PAGE = 1000;
const MAX_ROWS = 60_000;

type Db = SupabaseClient<any, any, any>;
async function loadEvents(db: Db): Promise<NegotiationEvent[]> {
  const base = () => db.from("events").select("*").neq("run_id", "exchange_state");
  const { count, error } = await db.from("events").select("id", { count: "exact", head: true }).neq("run_id", "exchange_state");
  if (error) throw error;
  const from = Math.max(0, (count ?? 0) - MAX_ROWS);
  const pages = await Promise.all(Array.from({ length: Math.ceil(((count ?? 0) - from) / PAGE) }, (_, i) =>
    base().order("ts", { ascending: true }).order("id", { ascending: true }).range(from + i * PAGE, from + (i + 1) * PAGE - 1)));
  const bad = pages.find((r) => r.error);
  if (bad?.error) throw bad.error;
  return pages.flatMap((r) => (r.data ?? []) as NegotiationEvent[]);
}

function liveFeed(url: string, key: string): Feed {
  return {
    mode: "live",
    label: "Live · Supabase",
    start(onEvents, onError) {
      const db = createClient(url, key);
      // Keyed by row id: realtime inserts that arrive while the initial load pages aren't lost or doubled.
      const byId = new Map<string, NegotiationEvent>();
      let loaded = false;
      let stopped = false;
      const add = (e: NegotiationEvent) => { if (isActivity(e)) byId.set(e.id ?? `${e.run_id}|${e.ts}|${e.type}|${byId.size}`, e); };
      const emit = () => { if (loaded && !stopped) onEvents([...byId.values()].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""))); };
      (async () => {
        try {
          for (const e of await loadEvents(db)) add(e);
        } catch (e) {
          return onError(`Couldn't load events: ${(e as { message?: string }).message ?? String(e)}`);
        }
        loaded = true;
        emit();
      })();
      const ch = db.channel("events-feed")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, (msg) => {
          add(msg.new as NegotiationEvent);
          emit();
        })
        .subscribe((status) => { if (status === "CHANNEL_ERROR") onError("Live updates disconnected; showing the last loaded events."); });
      return () => { stopped = true; void db.removeChannel(ch); };
    },
  };
}

function sampleFeed(): Feed {
  return {
    mode: "sample",
    label: "Sample data",
    start(onEvents) {
      const all = [...fakeComparison(60), ...fakeFollowups()].sort((a, b) => a.ts!.localeCompare(b.ts!));
      let shown = Math.floor(all.length * 0.55);
      onEvents(all.slice(0, shown));
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) { onEvents(all); return () => {}; }
      const t = setInterval(() => {
        shown = Math.min(all.length, shown + 3);
        onEvents(all.slice(0, shown));
        if (shown >= all.length) clearInterval(t);
      }, 700);
      return () => clearInterval(t);
    },
  };
}
