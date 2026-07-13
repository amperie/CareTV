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
  lastErrorMessage?: string;
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

interface ApplianceStatus {
  applianceId: string;
  name: string;
  connected: boolean;
  lastSeenAt: string;
}

interface PlaybackStatus {
  appliance?: ApplianceStatus;
  events: PlaybackEvent[];
  loopEnabled: boolean;
  queue: QueueEntry[];
  running: boolean;
  state?: PlaybackState;
}

function App() {
  const [durationSeconds, setDurationSeconds] = useState(12);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [scenario, setScenario] = useState("normal");
  const [queueMessage, setQueueMessage] = useState("");
  const [status, setStatus] = useState<PlaybackStatus | undefined>();
  const [title, setTitle] = useState("Fake movie");

  async function refresh() {
    const [mediaResponse, statusResponse] = await Promise.all([
      fetch(`${apiBase}/media`, { cache: "no-store" }),
      fetch(`${apiBase}/playback/status`, { cache: "no-store" })
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
    setQueueMessage("");
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

  async function resetLab() {
    setQueueMessage("");
    await post("/lab/reset", {});
    await refresh();
  }

  async function sendCommand(type: "pause" | "resume" | "skip") {
    await post("/commands", { type });
    await refresh();
  }

  async function toggleLoop() {
    await post("/playback/loop", { enabled: !status?.loopEnabled });
    await refresh();
  }

  async function removeQueueEntry(id: string) {
    setQueueMessage("");
    await request(`/queue/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function moveQueueEntry(id: string, direction: "up" | "down") {
    setQueueMessage("");

    try {
      await post(`/queue/${id}/move`, { direction });
      setStatus((current) => (current ? moveQueueInStatus(current, id, direction) : current));
      await refresh();
    } catch {
      setQueueMessage("That item is no longer movable. Stop playback, then reorder queued items.");
      await refresh();
    }
  }

  async function clearCompleted() {
    setQueueMessage("");
    await post("/queue/clear-completed", {});
    await refresh();
  }

  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);
  const queuedIds = useMemo(
    () => status?.queue.filter((entry) => entry.status === "queued").map((entry) => entry.id) ?? [],
    [status?.queue]
  );
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
          {status?.appliance?.connected ? status.appliance.name : "No appliance"}
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
          <button className="secondary" onClick={() => void resetLab()}>
            Reset lab
          </button>
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
            <button
              className={status?.loopEnabled ? "toggle active" : "toggle"}
              onClick={() => void toggleLoop()}
            >
              Loop
            </button>
            <button onClick={() => void stopPlayback()}>Stop</button>
          </div>
          <p className="appliance-line">
            {status?.running ? "Playback enabled" : "Playback stopped"} /{" "}
            {status?.appliance?.connected
              ? `connected ${new Date(status.appliance.lastSeenAt).toLocaleTimeString()}`
              : "appliance offline"}
          </p>
        </div>

        <div className="panel queue">
          <div className="section-header">
            <h2>Queue</h2>
            <button className="compact secondary" onClick={() => void clearCompleted()}>
              Clear done
            </button>
          </div>
          {queueMessage ? <p className="queue-message">{queueMessage}</p> : null}
          <div className="rows">
            {status?.queue.length ? (
              status.queue.map((entry) => {
                const queuedIndex = queuedIds.indexOf(entry.id);
                const canMoveUp = queuedIndex > 0;
                const canMoveDown = queuedIndex >= 0 && queuedIndex < queuedIds.length - 1;
                const disabledReason = status?.running
                  ? "Stop playback before reordering."
                  : "Only queued items with a queued neighbor can move.";

                return (
                  <div className="row" key={entry.id}>
                    <div>
                      <strong>
                        {mediaById.get(entry.mediaItemId)?.title ?? entry.mediaItemId}
                      </strong>
                      <span>
                        #{entry.position} - {scenarioLabel(mediaById.get(entry.mediaItemId))}
                      </span>
                      {entry.lastErrorCode ? (
                        <small>
                          {entry.lastErrorCode}
                          {entry.lastErrorMessage ? `: ${entry.lastErrorMessage}` : ""}
                        </small>
                      ) : null}
                    </div>
                    {entry.status === "queued" ? (
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          disabled={status?.running || !canMoveUp}
                          onClick={() => void moveQueueEntry(entry.id, "up")}
                          title={canMoveUp && !status?.running ? "Move up" : disabledReason}
                        >
                          Up
                        </button>
                        <button
                          className="icon-button"
                          disabled={status?.running || !canMoveDown}
                          onClick={() => void moveQueueEntry(entry.id, "down")}
                          title={canMoveDown && !status?.running ? "Move down" : disabledReason}
                        >
                          Down
                        </button>
                        <button
                          className="icon-button danger"
                          onClick={() => void removeQueueEntry(entry.id)}
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
                    <span className={`badge ${entry.status}`}>{entry.status}</span>
                  </div>
                );
              })
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
                  {event.type === "FAILED" ? ` (${formatDetail(event.details.code)})` : ""}
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
  await request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

async function request(path: string, init: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
}

function formatDetail(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "?";
}

function scenarioLabel(item: MediaItem | undefined): string {
  const scenario = item?.metadata.scenario;
  return typeof scenario === "string" ? scenario : "unknown";
}

function moveQueueInStatus(
  status: PlaybackStatus,
  id: string,
  direction: "up" | "down"
): PlaybackStatus {
  const queue = [...status.queue];
  const queuedIndexes = queue
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.status === "queued");
  const currentQueuedIndex = queuedIndexes.findIndex(({ entry }) => entry.id === id);
  const neighborQueuedIndex = direction === "up" ? currentQueuedIndex - 1 : currentQueuedIndex + 1;
  const current = queuedIndexes[currentQueuedIndex];
  const neighbor = queuedIndexes[neighborQueuedIndex];

  if (!current || !neighbor) {
    return status;
  }

  const currentEntry = queue[current.index];
  const neighborEntry = queue[neighbor.index];

  if (!currentEntry || !neighborEntry) {
    return status;
  }

  queue[current.index] = neighborEntry;
  queue[neighbor.index] = currentEntry;
  return { ...status, queue };
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
