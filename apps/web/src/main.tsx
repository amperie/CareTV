import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const apiBase = `http://${window.location.hostname}:4010/api/v1`;

interface MediaItem {
  id: string;
  service: string;
  title: string;
  expectedDurationSeconds?: number;
  localPath?: string;
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
  const [primeUrl, setPrimeUrl] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [status, setStatus] = useState<PlaybackStatus | undefined>();
  const [title, setTitle] = useState("Fake movie");
  const [uploading, setUploading] = useState(false);

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

  async function addPrimeItem() {
    await addStreamingItem("/prime-queue", primeUrl, setPrimeUrl, "Enter an Amazon Prime Video URL.");
  }

  async function addYoutubeItem() {
    await addStreamingItem("/youtube-queue", youtubeUrl, setYoutubeUrl, "Enter a YouTube URL.");
  }

  async function addStreamingItem(
    path: string,
    url: string,
    clear: (value: string) => void,
    errorMessage: string
  ) {
    setQueueMessage("");
    try {
      await post(path, { url });
      clear("");
    } catch {
      setQueueMessage(errorMessage);
    }
    await refresh();
  }

  async function enqueueMedia(mediaItemId: string) {
    setQueueMessage("");
    await post("/queue", { mediaItemId });
    await refresh();
  }

  async function deleteMedia(mediaItemId: string) {
    setQueueMessage("");
    try {
      await request(`/media/${mediaItemId}`, { method: "DELETE" });
    } catch {
      setQueueMessage("Stop playback before deleting the active media item.");
    }
    await refresh();
  }

  async function uploadMedia(file: File | undefined) {
    if (!file) {
      return;
    }

    setUploading(true);
    setQueueMessage("");
    try {
      await request(`/uploads?filename=${encodeURIComponent(file.name)}`, {
        body: await file.arrayBuffer(),
        headers: { "content-type": "application/octet-stream" },
        method: "POST"
      });
      await refresh();
    } finally {
      setUploading(false);
    }
  }

  async function startPlayback() {
    await post("/playback/start", {});
    await refresh();
  }

  async function stopPlayback() {
    await post("/playback/stop", {});
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

  async function playQueueEntry(id: string) {
    setQueueMessage("");
    try {
      await post(`/queue/${id}/play`, {});
    } catch {
      setQueueMessage("That item cannot be played right now.");
    }
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
  const localMedia = useMemo(() => {
    const seen = new Set<string>();
    return media.filter((item) => {
      if (item.service !== "local") {
        return false;
      }

      const key = item.localPath ?? item.id;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }, [media]);
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

        <div className="panel media-panel">
          <div className="section-header">
            <h2>Discovered media</h2>
            <label className={uploading ? "upload-button disabled" : "upload-button"}>
              Upload
              <input
                accept="video/*,.mkv,.avi"
                disabled={uploading}
                type="file"
                onChange={(event) => {
                  void uploadMedia(event.target.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <div className="rows">
            {localMedia.length ? (
              localMedia.map((item) => (
                <div className="row media-row" key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.localPath ? item.localPath : uploadStatus(item)}</span>
                  </div>
                  <div className="row-actions">
                    <button
                      className="compact"
                      disabled={!item.localPath}
                      onClick={() => void enqueueMedia(item.id)}
                      title={item.localPath ? "Add to queue" : "Waiting for appliance download"}
                    >
                      Queue
                    </button>
                    <button
                      className="compact danger"
                      onClick={() => void deleteMedia(item.id)}
                      title="Remove this media from the catalog"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">No local media discovered yet.</p>
            )}
          </div>
        </div>

        <div className="panel prime-panel">
          <h2>Add streaming item</h2>
          <label>
            Prime URL
            <input
              placeholder="https://www.amazon.com/gp/video/detail/..."
              value={primeUrl}
              onChange={(event) => setPrimeUrl(event.target.value)}
            />
          </label>
          <button onClick={() => void addPrimeItem()}>Add to queue</button>
          <label>
            YouTube URL
            <input
              placeholder="https://www.youtube.com/watch?v=..."
              value={youtubeUrl}
              onChange={(event) => setYoutubeUrl(event.target.value)}
            />
          </label>
          <button onClick={() => void addYoutubeItem()}>Add to queue</button>
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
                const canPlay = !["starting", "playing", "paused", "cancelled"].includes(
                  entry.status
                );
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
                    {canPlay || entry.status === "queued" ? (
                      <div className="row-actions">
                        {canPlay ? (
                          <button
                            className="icon-button play"
                            onClick={() => void playQueueEntry(entry.id)}
                            title="Play this item next"
                          >
                            Play
                          </button>
                        ) : null}
                        {entry.status === "queued" ? (
                          <>
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
                          </>
                        ) : null}
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
  if (item?.service === "prime" || item?.service === "youtube") {
    return item.service;
  }

  const scenario = item?.metadata.scenario;
  return typeof scenario === "string" ? scenario : "unknown";
}

function uploadStatus(item: MediaItem): string {
  const upload = item.metadata.upload;
  return upload && typeof upload === "object" && "status" in upload
    ? `upload ${String(upload.status)}`
    : "waiting for appliance";
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
