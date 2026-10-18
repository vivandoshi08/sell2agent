import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Console } from "./console/Console";
import { Store } from "./store/Store";
import "./ui/styles.css";

// /console (or ?console) is the merchant console; everything else is the proof dashboard.
// /store?seller=<id> is that seller's own page (payouts, sales, pickup).
const path = location.pathname.replace(/\/+$/, "");
const isConsole = path.endsWith("/console") || new URLSearchParams(location.search).has("console");
const isStore = path.endsWith("/store");
createRoot(document.getElementById("root")!).render(<StrictMode>{isStore ? <Store /> : isConsole ? <Console /> : <App />}</StrictMode>);
