/** The app bar shared by Live, Results and Rules, so the merchant never loses the nav when switching pages. */
import { Mark } from "./Brand";

export type Tab = "live" | "proof" | "rules";

// Live and Results are hash views of the dashboard page; Rules is its own page (/console). Keep the query (?sample,
// ?local, ?eval=…) so switching tabs never silently changes which data is on screen.
const q = () => location.search;
const onConsole = () => location.pathname.replace(/\/+$/, "").endsWith("/console");
const dash = (hash: string) => (onConsole() ? `./${q()}#${hash}` : `#${hash}`);

export function TopBar({ tab, badge }: { tab: Tab; badge?: { mode: string; label: string } | null }) {
  return (
    <header className="topbar">
      <div className="brand"><Mark /><b>Counter</b></div>
      <span className="store"><span className="av">KF</span>Keyforge</span>
      <nav className="tabs" aria-label="Views">
        <a href={dash("live")} aria-current={tab === "live" ? "page" : undefined}>Live</a>
        <a href={dash("proof")} aria-current={tab === "proof" ? "page" : undefined}>Results</a>
        <a href={onConsole() ? q() || "?" : `console${q()}`} aria-current={tab === "rules" ? "page" : undefined}>Rules</a>
      </nav>
      <span className="sp" />
      {badge && <span className={`data-badge ${badge.mode}`}><i />{badge.label}</span>}
    </header>
  );
}
