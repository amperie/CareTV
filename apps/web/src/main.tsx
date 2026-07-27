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
  url?: string;
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

interface PlaybackStatus {
  appliance?: { applianceId: string; name: string; connected: boolean; lastSeenAt: string };
  events: { id: string; type: string; createdAt: string; details: Record<string, unknown> }[];
  loopEnabled: boolean;
  queue: QueueEntry[];
  running: boolean;
  state?: {
    phase: string;
    title?: string;
    positionSeconds?: number;
    durationSeconds?: number;
    error?: { code: string; message: string };
  };
}

interface Playlist {
  id: string;
  name: string;
  items: { mediaItemId: string; position: number }[];
}

type DashboardTab = "main" | "media" | "events";

function App() {
  const [activeTab, setActiveTab] = useState<DashboardTab>("main");
  const [durationSeconds, setDurationSeconds] = useState(12);
  const [editingPlaylistId, setEditingPlaylistId] = useState<string>();
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaSearch, setMediaSearch] = useState("");
  const [playlistMediaIds, setPlaylistMediaIds] = useState<string[]>([]);
  const [playlistName, setPlaylistName] = useState("New playlist");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [queueMessage, setQueueMessage] = useState("");
  const [scenario, setScenario] = useState("normal");
  const [status, setStatus] = useState<PlaybackStatus>();
  const [streamingUrl, setStreamingUrl] = useState("");
  const [title, setTitle] = useState("Fake movie");
  const [uploading, setUploading] = useState(false);

  async function refresh() {
    const [mediaResponse, playlistsResponse, statusResponse] = await Promise.all([
      fetch(`${apiBase}/media`, { cache: "no-store" }),
      fetch(`${apiBase}/playlists`, { cache: "no-store" }),
      fetch(`${apiBase}/playback/status`, { cache: "no-store" })
    ]);
    setMedia((await mediaResponse.json()) as MediaItem[]);
    setPlaylists((await playlistsResponse.json()) as Playlist[]);
    setStatus((await statusResponse.json()) as PlaybackStatus);
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);
  const discoveredMedia = useMemo(() => {
    const seen = new Set<string>();
    const query = mediaSearch.trim().toLowerCase();

    return media.filter((item) => {
      const key =
        item.service === "local"
          ? `${item.service}:${item.localPath ?? item.id}`
          : `${item.service}:${item.url ?? item.id}`;

      if (seen.has(key)) return false;
      seen.add(key);

      return (
        !query ||
        item.title.toLowerCase().includes(query) ||
        item.service.toLowerCase().includes(query) ||
        (item.localPath ?? "").toLowerCase().includes(query)
      );
    });
  }, [media, mediaSearch]);
  const queuedIds = useMemo(
    () => status?.queue.filter((entry) => entry.status === "queued").map((entry) => entry.id) ?? [],
    [status?.queue]
  );
  const state = status?.state;
  const progress =
    state?.positionSeconds !== undefined && state.durationSeconds
      ? Math.min(100, Math.round((state.positionSeconds / state.durationSeconds) * 100))
      : 0;

  async function addFakeItem() {
    setQueueMessage("");
    await post("/fake-queue", { title, scenario, durationSeconds });
    await refresh();
  }

  async function addStreamingItem() {
    setQueueMessage("");
    const path = streamingQueuePath(streamingUrl);

    if (!path) {
      setQueueMessage("Enter a YouTube or Amazon Prime Video URL.");
      return;
    }

    try {
      await post(path, { url: streamingUrl });
      setStreamingUrl("");
    } catch {
      setQueueMessage("That streaming URL could not be added.");
    }
    await refresh();
  }

  async function uploadMedia(file: File | undefined) {
    if (!file) return;
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

  async function savePlaylist() {
    setQueueMessage("");

    if (!playlistMediaIds.length) {
      setQueueMessage("Select at least one media item for the playlist.");
      return;
    }

    const body = { mediaItemIds: playlistMediaIds, name: playlistName };
    try {
      if (editingPlaylistId) {
        await post(`/playlists/${editingPlaylistId}`, body, "PUT");
      } else {
        await post("/playlists", body);
      }
      clearPlaylistBuilder();
    } catch {
      setQueueMessage("Playlist could not be saved.");
    }
    await refresh();
  }

  async function queuePlaylist(id: string) {
    setQueueMessage("");
    try {
      await post(`/playlists/${id}/queue`, {});
    } catch {
      setQueueMessage("That playlist has no available media.");
    }
    await refresh();
  }

  async function deletePlaylist(id: string) {
    setQueueMessage("");
    await request(`/playlists/${id}`, { method: "DELETE" });
    if (editingPlaylistId === id) clearPlaylistBuilder();
    await refresh();
  }

  function editPlaylist(playlist: Playlist) {
    setEditingPlaylistId(playlist.id);
    setPlaylistName(playlist.name);
    setPlaylistMediaIds(
      [...playlist.items].sort((a, b) => a.position - b.position).map((item) => item.mediaItemId)
    );
  }

  function clearPlaylistBuilder() {
    setEditingPlaylistId(undefined);
    setPlaylistName("New playlist");
    setPlaylistMediaIds([]);
  }

  function togglePlaylistMedia(mediaItemId: string) {
    setPlaylistMediaIds((current) =>
      current.includes(mediaItemId)
        ? current.filter((id) => id !== mediaItemId)
        : [...current, mediaItemId]
    );
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

  async function sendCommand(type: "pause" | "restart" | "resume" | "skip") {
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

      <nav className="tabs" aria-label="Dashboard sections">
        {(["main", "media", "events"] as DashboardTab[]).map((tab) => (
          <button
            className={activeTab === tab ? "tab active" : "tab"}
            key={tab}
            onClick={() => setActiveTab(tab)}
          >
            {tabLabel(tab)}
          </button>
        ))}
      </nav>

      {activeTab === "main" ? (
        <section className="layout">
          <FakeControls
            durationSeconds={durationSeconds}
            scenario={scenario}
            title={title}
            onAdd={() => void addFakeItem()}
            onDurationChange={setDurationSeconds}
            onReset={() => void resetLab()}
            onScenarioChange={setScenario}
            onTitleChange={setTitle}
          />
          <OutputPanel
            progress={progress}
            state={state}
            status={status}
            onCommand={(type) => void sendCommand(type)}
            onLoop={() => void toggleLoop()}
            onStart={() => void startPlayback()}
            onStop={() => void stopPlayback()}
          />
          <QueuePanel
            mediaById={mediaById}
            message={queueMessage}
            queuedIds={queuedIds}
            status={status}
            onClearCompleted={() => void clearCompleted()}
            onMove={(id, direction) => void moveQueueEntry(id, direction)}
            onPlay={(id) => void playQueueEntry(id)}
            onRemove={(id) => void removeQueueEntry(id)}
          />
        </section>
      ) : activeTab === "media" ? (
        <section className="media-layout">
          <MediaPanel
            discoveredMedia={discoveredMedia}
            mediaSearch={mediaSearch}
            playlistMediaIds={playlistMediaIds}
            uploading={uploading}
            onDelete={(id) => void deleteMedia(id)}
            onEnqueue={(id) => void enqueueMedia(id)}
            onSearchChange={setMediaSearch}
            onTogglePlaylistMedia={togglePlaylistMedia}
            onUpload={(file) => void uploadMedia(file)}
          />
          <StreamingPanel
            streamingUrl={streamingUrl}
            onAdd={() => void addStreamingItem()}
            onUrlChange={setStreamingUrl}
          />
          <PlaylistBuilder
            editing={Boolean(editingPlaylistId)}
            mediaById={mediaById}
            name={playlistName}
            selectedIds={playlistMediaIds}
            onClear={clearPlaylistBuilder}
            onNameChange={setPlaylistName}
            onRemove={togglePlaylistMedia}
            onSave={() => void savePlaylist()}
          />
          <PlaylistList
            mediaById={mediaById}
            message={queueMessage}
            playlists={playlists}
            onDelete={(id) => void deletePlaylist(id)}
            onEdit={editPlaylist}
            onQueue={(id) => void queuePlaylist(id)}
          />
        </section>
      ) : (
        <EventsPanel status={status} />
      )}
    </main>
  );
}

function FakeControls(props: {
  durationSeconds: number;
  scenario: string;
  title: string;
  onAdd: () => void;
  onDurationChange: (value: number) => void;
  onReset: () => void;
  onScenarioChange: (value: string) => void;
  onTitleChange: (value: string) => void;
}) {
  return (
    <div className="panel controls">
      <h2>Add fake item</h2>
      <label>
        Title
        <input value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} />
      </label>
      <label>
        Duration
        <input
          min="3"
          type="number"
          value={props.durationSeconds}
          onChange={(event) => props.onDurationChange(Number(event.target.value))}
        />
      </label>
      <label>
        Scenario
        <select
          value={props.scenario}
          onChange={(event) => props.onScenarioChange(event.target.value)}
        >
          <option value="normal">Normal</option>
          <option value="buffering">Buffering</option>
          <option value="interrupt-then-recover">Interrupt then recover</option>
          <option value="login-required">Login required</option>
          <option value="playback-failure">Playback failure</option>
        </select>
      </label>
      <button onClick={() => props.onAdd()}>Add to queue</button>
      <button className="secondary" onClick={() => props.onReset()}>
        Reset lab
      </button>
    </div>
  );
}

function OutputPanel(props: {
  progress: number;
  state: PlaybackStatus["state"];
  status: PlaybackStatus | undefined;
  onCommand: (type: "pause" | "restart" | "resume" | "skip") => void;
  onLoop: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div className="panel output">
      <div className="output-header">
        <h2>{props.state?.title ?? "Nothing playing"}</h2>
        <span>{props.state?.phase ?? "idle"}</span>
      </div>
      <div className="screen">
        <div className="screen-title">{props.state?.title ?? "CareTV output"}</div>
        <div className="screen-phase">{props.state?.phase ?? "Waiting for queue"}</div>
        <div className="progress">
          <div style={{ width: `${props.progress}%` }} />
        </div>
        <div className="time">
          {props.state?.positionSeconds ?? 0}s / {props.state?.durationSeconds ?? 0}s
        </div>
      </div>
      {props.state?.error ? (
        <p className="error">
          {props.state.error.code}: {props.state.error.message}
        </p>
      ) : null}
      <div className="button-row">
        <button onClick={() => props.onStart()}>Start</button>
        <button onClick={() => props.onCommand("pause")}>Pause</button>
        <button onClick={() => props.onCommand("resume")}>Resume</button>
        <button onClick={() => props.onCommand("restart")}>Rewind</button>
        <button onClick={() => props.onCommand("skip")}>Skip</button>
        <button
          className={props.status?.loopEnabled ? "toggle active" : "toggle"}
          onClick={() => props.onLoop()}
        >
          Loop
        </button>
        <button onClick={() => props.onStop()}>Stop</button>
      </div>
      <p className="appliance-line">
        {props.status?.running ? "Playback enabled" : "Playback stopped"} /{" "}
        {props.status?.appliance?.connected
          ? `connected ${new Date(props.status.appliance.lastSeenAt).toLocaleTimeString()}`
          : "appliance offline"}
      </p>
    </div>
  );
}

function QueuePanel(props: {
  mediaById: Map<string, MediaItem>;
  message: string;
  queuedIds: string[];
  status: PlaybackStatus | undefined;
  onClearCompleted: () => void;
  onMove: (id: string, direction: "up" | "down") => void;
  onPlay: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="panel queue">
      <div className="section-header">
        <h2>Queue</h2>
        <button className="compact secondary" onClick={() => props.onClearCompleted()}>
          Clear done
        </button>
      </div>
      {props.message ? <p className="queue-message">{props.message}</p> : null}
      <div className="rows">
        {props.status?.queue.length ? (
          props.status.queue.map((entry) => (
            <QueueRow
              entry={entry}
              key={entry.id}
              media={props.mediaById.get(entry.mediaItemId)}
              queuedIds={props.queuedIds}
              running={Boolean(props.status?.running)}
              onMove={props.onMove}
              onPlay={props.onPlay}
              onRemove={props.onRemove}
            />
          ))
        ) : (
          <p className="muted">No queued items yet.</p>
        )}
      </div>
    </div>
  );
}

function QueueRow(props: {
  entry: QueueEntry;
  media: MediaItem | undefined;
  queuedIds: string[];
  running: boolean;
  onMove: (id: string, direction: "up" | "down") => void;
  onPlay: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const queuedIndex = props.queuedIds.indexOf(props.entry.id);
  const canMoveUp = queuedIndex > 0;
  const canMoveDown = queuedIndex >= 0 && queuedIndex < props.queuedIds.length - 1;
  const canPlay = !["starting", "playing", "paused", "cancelled"].includes(props.entry.status);
  const disabledReason = props.running
    ? "Stop playback before reordering."
    : "Only queued items with a queued neighbor can move.";

  return (
    <div className="row">
      <div>
        <strong>{props.media?.title ?? props.entry.mediaItemId}</strong>
        <span>
          #{props.entry.position} - {scenarioLabel(props.media)}
        </span>
        {props.entry.lastErrorCode ? (
          <small>
            {props.entry.lastErrorCode}
            {props.entry.lastErrorMessage ? `: ${props.entry.lastErrorMessage}` : ""}
          </small>
        ) : null}
      </div>
      {canPlay || props.entry.status === "queued" ? (
        <div className="row-actions">
          {canPlay ? (
            <button
              className="icon-button play"
              onClick={() => props.onPlay(props.entry.id)}
              title="Play this item next"
            >
              Play
            </button>
          ) : null}
          {props.entry.status === "queued" ? (
            <>
              <button
                className="icon-button"
                disabled={props.running || !canMoveUp}
                onClick={() => props.onMove(props.entry.id, "up")}
                title={canMoveUp && !props.running ? "Move up" : disabledReason}
              >
                Up
              </button>
              <button
                className="icon-button"
                disabled={props.running || !canMoveDown}
                onClick={() => props.onMove(props.entry.id, "down")}
                title={canMoveDown && !props.running ? "Move down" : disabledReason}
              >
                Down
              </button>
              <button className="icon-button danger" onClick={() => props.onRemove(props.entry.id)}>
                Remove
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <span className={`badge ${props.entry.status}`}>{props.entry.status}</span>
    </div>
  );
}

function MediaPanel(props: {
  discoveredMedia: MediaItem[];
  mediaSearch: string;
  playlistMediaIds: string[];
  uploading: boolean;
  onDelete: (id: string) => void;
  onEnqueue: (id: string) => void;
  onSearchChange: (value: string) => void;
  onTogglePlaylistMedia: (id: string) => void;
  onUpload: (file: File | undefined) => void;
}) {
  return (
    <div className="panel media-panel">
      <div className="section-header">
        <h2>Discovered media</h2>
        <label className={props.uploading ? "upload-button disabled" : "upload-button"}>
          Upload
          <input
            accept="video/*,.mkv,.avi"
            disabled={props.uploading}
            type="file"
            onChange={(event) => {
              props.onUpload(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      <input
        aria-label="Search discovered media"
        placeholder="Search discovered media"
        value={props.mediaSearch}
        onChange={(event) => props.onSearchChange(event.target.value)}
      />
      <div className="rows">
        {props.discoveredMedia.length ? (
          props.discoveredMedia.map((item) => (
            <div className="row media-row" key={item.id}>
              <label className="check-row">
                <input
                  checked={props.playlistMediaIds.includes(item.id)}
                  type="checkbox"
                  onChange={() => props.onTogglePlaylistMedia(item.id)}
                />
              </label>
              <div>
                <strong>{item.title}</strong>
                <span>{mediaSourceLabel(item)}</span>
              </div>
              <div className="row-actions">
                <button
                  className="compact"
                  disabled={item.service === "local" && !item.localPath}
                  onClick={() => props.onEnqueue(item.id)}
                  title={
                    item.service !== "local" || item.localPath
                      ? "Add to queue"
                      : "Waiting for appliance download"
                  }
                >
                  Queue
                </button>
                <button
                  className="compact danger"
                  onClick={() => props.onDelete(item.id)}
                  title="Remove this media from the catalog"
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">No discovered media matches.</p>
        )}
      </div>
    </div>
  );
}

function StreamingPanel(props: {
  streamingUrl: string;
  onAdd: () => void;
  onUrlChange: (value: string) => void;
}) {
  return (
    <div className="panel prime-panel">
      <h2>Add streaming item</h2>
      <label>
        URL
        <input
          placeholder="YouTube or Amazon Prime Video URL"
          value={props.streamingUrl}
          onChange={(event) => props.onUrlChange(event.target.value)}
        />
      </label>
      <button onClick={() => props.onAdd()}>Add to queue</button>
    </div>
  );
}

function PlaylistBuilder(props: {
  editing: boolean;
  mediaById: Map<string, MediaItem>;
  name: string;
  selectedIds: string[];
  onClear: () => void;
  onNameChange: (value: string) => void;
  onRemove: (id: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="panel playlist-panel">
      <div className="section-header">
        <h2>{props.editing ? "Edit playlist" : "Create playlist"}</h2>
        <button className="compact secondary" onClick={() => props.onClear()}>
          New
        </button>
      </div>
      <label>
        Name
        <input value={props.name} onChange={(event) => props.onNameChange(event.target.value)} />
      </label>
      <div className="playlist-selection">
        {props.selectedIds.length ? (
          props.selectedIds.map((id, index) => (
            <div className="playlist-chip" key={id}>
              <span>
                {index + 1}. {props.mediaById.get(id)?.title ?? id}
              </span>
              <button className="compact secondary" onClick={() => props.onRemove(id)}>
                Remove
              </button>
            </div>
          ))
        ) : (
          <p className="muted">Select media items from the list.</p>
        )}
      </div>
      <button onClick={() => props.onSave()}>Save playlist</button>
    </div>
  );
}

function PlaylistList(props: {
  mediaById: Map<string, MediaItem>;
  message: string;
  playlists: Playlist[];
  onDelete: (id: string) => void;
  onEdit: (playlist: Playlist) => void;
  onQueue: (id: string) => void;
}) {
  return (
    <div className="panel playlist-panel">
      <h2>Playlists</h2>
      {props.message ? <p className="queue-message">{props.message}</p> : null}
      <div className="rows">
        {props.playlists.length ? (
          props.playlists.map((playlist) => (
            <div className="row media-row" key={playlist.id}>
              <div>
                <strong>{playlist.name}</strong>
                <span>{playlistSummary(playlist, props.mediaById)}</span>
              </div>
              <div className="row-actions">
                <button className="compact" onClick={() => props.onQueue(playlist.id)}>
                  Queue
                </button>
                <button className="compact secondary" onClick={() => props.onEdit(playlist)}>
                  Edit
                </button>
                <button className="compact danger" onClick={() => props.onDelete(playlist.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">No playlists yet.</p>
        )}
      </div>
    </div>
  );
}

function EventsPanel(props: { status: PlaybackStatus | undefined }) {
  return (
    <section className="events-layout">
      <div className="panel events">
        <h2>Output events</h2>
        <div className="event-list">
          {props.status?.events.map((event) => (
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
  );
}

async function post(path: string, body: Record<string, unknown>, method = "POST") {
  await request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  });
}

async function request(path: string, init: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, init);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
}

function tabLabel(tab: DashboardTab): string {
  return tab[0]!.toUpperCase() + tab.slice(1);
}

function formatDetail(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "?";
}

function scenarioLabel(item: MediaItem | undefined): string {
  if (item?.service === "prime" || item?.service === "youtube") return item.service;
  const scenario = item?.metadata.scenario;
  return typeof scenario === "string" ? scenario : "unknown";
}

function uploadStatus(item: MediaItem): string {
  const upload = item.metadata.upload;
  return upload && typeof upload === "object" && "status" in upload
    ? `upload ${String(upload.status)}`
    : "waiting for appliance";
}

function streamingQueuePath(input: string): "/prime-queue" | "/youtube-queue" | undefined {
  try {
    const host = new URL(input).hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
      return "/youtube-queue";
    }
    if (host.includes("amazon.") || host.endsWith("primevideo.com")) return "/prime-queue";
  } catch {
    return undefined;
  }
  return undefined;
}

function mediaSourceLabel(item: MediaItem): string {
  return item.service === "local" ? (item.localPath ?? uploadStatus(item)) : item.service;
}

function playlistSummary(playlist: Playlist, mediaById: Map<string, MediaItem>): string {
  const names = [...playlist.items]
    .sort((a, b) => a.position - b.position)
    .slice(0, 3)
    .map((item) => mediaById.get(item.mediaItemId)?.title)
    .filter(Boolean);
  return `${playlist.items.length} items${names.length ? `: ${names.join(", ")}` : ""}`;
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

  if (!current || !neighbor) return status;

  const currentEntry = queue[current.index];
  const neighborEntry = queue[neighbor.index];

  if (!currentEntry || !neighborEntry) return status;

  queue[current.index] = neighborEntry;
  queue[neighbor.index] = currentEntry;
  return { ...status, queue };
}

const root = document.getElementById("root");

if (!root) throw new Error("Root element was not found.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
