import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Console } from "./console/Console";
import "./ui/styles.css";

// /console (or ?console) is the merchant console; /video is the demo-video stage; everything else is the proof dashboard.
const path = location.pathname.replace(/\/+$/, "");
const isConsole = path.endsWith("/console") || new URLSearchParams(location.search).has("console");
const root = createRoot(document.getElementById("root")!);
if (path.endsWith("/video")) import("./video/VideoFrame").then(({ VideoFrame }) => root.render(<VideoFrame />));
else root.render(<StrictMode>{isConsole ? <Console /> : <App />}</StrictMode>);
