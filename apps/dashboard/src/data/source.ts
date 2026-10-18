/**
 * Where events come from. Live: Supabase `events` (initial load + realtime inserts).
 * Sample: fake events replayed over time so the feed moves, labelled "Sample data" in the UI.
 * The browser only ever gets SUPABASE_URL and the anon key (see vite.config.ts).
 */
import { createClient } from "@supabase/supabase-js";
import type { NegotiationEvent } from "@sa/shared";
import { fakeComparison } from "./fake";

export type Mode = "live" | "sample";
export interface Feed {
  mode: Mode;
  /** Calls back with the full event list whenever it grows. Returns an unsubscribe. */
  start(onEvents: (all: NegotiationEvent[]) => void, onError: (msg: string) => void): () => void;
}

const URL_ = import.meta.env.SA_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.SA_SUPABASE_ANON_KEY as string | undefined;

export function pickFeed(): Feed {
  const forceSample = new URLSearchParams(location.search).has("sample");
  return URL_ && KEY && !forceSample ? liveFeed(URL_, KEY) : sampleFeed();
}

function liveFeed(url: string, key: string): Feed {
  return {
    mode: "live",
    start(onEvents, onError) {
      const db = createClient(url, key);
      let all: NegotiationEvent[] = [];
      let stopped = false;
      (async () => {
        const { data, error } = await db.from("events").select("*").order("ts", { ascending: false }).limit(5000);
        if (error) return onError(`Couldn't load events: ${error.message}`);
        if (stopped) return;
        all = (data as NegotiationEvent[]).reverse();
        onEvents(all);
      })();
      const ch = db.channel("events-feed")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, (msg) => {
          all = [...all, msg.new as NegotiationEvent];
          onEvents(all);
        })
        .subscribe((status) => { if (status === "CHANNEL_ERROR") onError("Live updates disconnected; showing the last loaded events."); });
      return () => { stopped = true; void db.removeChannel(ch); };
    },
  };
}

function sampleFeed(): Feed {
  return {
    mode: "sample",
    start(onEvents) {
      const all = fakeComparison(60);
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
