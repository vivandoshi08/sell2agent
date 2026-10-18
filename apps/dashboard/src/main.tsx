import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Console } from "./console/Console";
import "./ui/styles.css";

// /console (or ?console) is the merchant console; everything else is the proof dashboard.
const isConsole = location.pathname.replace(/\/+$/, "").endsWith("/console") || new URLSearchParams(location.search).has("console");
createRoot(document.getElementById("root")!).render(<StrictMode>{isConsole ? <Console /> : <App />}</StrictMode>);
