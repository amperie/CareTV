import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const apiBase = "http://127.0.0.1:4010/api/v1";

interface MediaItem {
  id: string;
  title: string;
  expectedDurationSeconds?: number;
  metadata: Record<string, unknown>;
}

interface QueueEntry {
  id: string;
  mediaItemId: string;
  position: number;
  status: string;
  lastErrorCode?: string;
}

interface PlaybackEvent {
  id: string;
  type: string;
  createdAt: string;
  details: Record<string, unknown>;
}

interface PlaybackState {
  phase: string;
  title?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  fullscreen?: boolean;
  error?: { code: string; message: string };
}

interface PlaybackStatus {
  events: PlaybackEvent[];
  queue: QueueEntry[];
  running: boolean;
  state?: PlaybackState;
}

function App() {
  const [durationSeconds, setDurationSeconds] = useState(12);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [scenario, setScenario] = useState("normal");
  const [status, setStatus] = useState<PlaybackStatus | undefined>();
  const [title, setTitle] = useState("Fake movie");

  async function refresh() {
    const [mediaResponse, statusResponse] = await Promise.all([
      fetch(`${apiBase}/media`),
      fetch(`${apiBase}/playback/status`)
    ]);
    setMedia((await mediaResponse.json()) as MediaItem[]);
    setStatus((await statusResponse.json()) as PlaybackStatus);
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function addFakeItem() {
    await post("/fake-queue", { title, scenario, durationSeconds });
    await refresh();
  }

  async function startPlayback() {
    await post("/playback/start", {});
    await refresh();
  }

  async function stopPlayback() {
    await post("/playback/stop", {});
    await post("/commands", { type: "stop" });
    await refresh();
  }

  async function sendCommand(type: "pause" | "resume" | "skip") {
    await post("/commands", { type });
    await refresh();
  }

  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);
  const state = status?.state;
  const progress =
    state?.positionSeconds !== undefined && state.durationSeconds
      ? Math.min(100, Math.round((state.positionSeconds / state.durationSeconds) * 100))
      : 0;

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">CareTV</p>
          <h1>Fake playback lab</h1>
        </div>
        <div className={status?.running ? "status running" : "status"}>
          {status?.running ? "Running" : "Stopped"}
        </div>
      </header>

      <section className="layout">
        <div className="panel controls">
          <h2>Add fake item</h2>
          <label>
            Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Duration
            <input
              min="3"
              type="number"
              value={durationSeconds}
              onChange={(event) => setDurationSeconds(Number(event.target.value))}
            />
          </label>
          <label>
            Scenario
            <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
              <option value="normal">Normal</option>
              <option value="buffering">Buffering</option>
              <option value="interrupt-then-recover">Interrupt then recover</option>
              <option value="login-required">Login required</option>
              <option value="playback-failure">Playback failure</option>
            </select>
          </label>
          <button onClick={() => void addFakeItem()}>Add to queue</button>
        </div>

        <div className="panel output">
          <div className="output-header">
            <h2>{state?.title ?? "Nothing playing"}</h2>
            <span>{state?.phase ?? "idle"}</span>
          </div>
          <div className="screen">
            <div className="screen-title">{state?.title ?? "CareTV output"}</div>
            <div className="screen-phase">{state?.phase ?? "Waiting for queue"}</div>
            <div className="progress">
              <div style={{ width: `${progress}%` }} />
            </div>
            <div className="time">
              {state?.positionSeconds ?? 0}s / {state?.durationSeconds ?? 0}s
            </div>
          </div>
          {state?.error ? (
            <p className="error">
              {state.error.code}: {state.error.message}
            </p>
          ) : null}
          <div className="button-row">
            <button onClick={() => void startPlayback()}>Start</button>
            <button onClick={() => void sendCommand("pause")}>Pause</button>
            <button onClick={() => void sendCommand("resume")}>Resume</button>
            <button onClick={() => void sendCommand("skip")}>Skip</button>
            <button onClick={() => void stopPlayback()}>Stop</button>
          </div>
        </div>

        <div className="panel queue">
          <h2>Queue</h2>
          <div className="rows">
            {status?.queue.length ? (
              status.queue.map((entry) => (
                <div className="row" key={entry.id}>
                  <div>
                    <strong>{mediaById.get(entry.mediaItemId)?.title ?? entry.mediaItemId}</strong>
                    <span>#{entry.position}</span>
                  </div>
                  <span className={`badge ${entry.status}`}>{entry.status}</span>
                </div>
              ))
            ) : (
              <p className="muted">No queued items yet.</p>
            )}
          </div>
        </div>

        <div className="panel events">
          <h2>Output events</h2>
          <div className="event-list">
            {status?.events.map((event) => (
              <div className="event" key={event.id}>
                <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                <strong>{event.type}</strong>
                <code>
                  {formatDetail(event.details.from)} -&gt; {formatDetail(event.details.to)}
                </code>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${apiBase}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
}

function formatDetail(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "?";
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
