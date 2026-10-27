import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { reportIssue } from "./api/client";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Browser errors go to the server log (server/logs/kompass.log, scope "web:window").
window.addEventListener("error", (e) => reportIssue("error", "window", e.message || "Script error", { source: e.filename, line: e.lineno, col: e.colno, page: location.pathname, stack: e.error?.stack }));
window.addEventListener("unhandledrejection", (e) => reportIssue("error", "window", `Unhandled promise rejection: ${String(e.reason?.message ?? e.reason)}`, { page: location.pathname, stack: e.reason?.stack }));
