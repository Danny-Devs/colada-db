import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// No <StrictMode>: its double-invoked effects would open and close every
// storage engine twice on mount, and opfs-sahpool is single-connection
// (ADR-003) — the second open of the same file would silently degrade to
// in-memory. A scaffold should not have to explain a phantom fallback.
createRoot(document.getElementById("root")!).render(<App />);
