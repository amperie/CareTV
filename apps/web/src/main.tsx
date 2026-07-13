import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

function App() {
  return (
    <main className="shell">
      <section className="status-panel">
        <p className="eyebrow">CareTV</p>
        <h1>Playback dashboard placeholder</h1>
        <p>
          Phase 0 is wired. Queue controls, diagnostics, screenshots, and playback state arrive in
          later tasks.
        </p>
      </section>
    </main>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
