import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Container,
  FileButton,
  Grid,
  Group,
  MantineProvider,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  createTheme
} from "@mantine/core";
import "@mantine/core/styles.css";
import {
  IconArrowDown,
  IconArrowUp,
  IconAlertTriangle,
  IconEraser,
  IconExternalLink,
  IconLogin2,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconPlus,
  IconRepeat,
  IconRotateClockwise2,
  IconSearch,
  IconTrash,
  IconUpload
} from "@tabler/icons-react";

import "./styles.css";

const apiBase = "/api/v1";
const authTokenKey = "caretv.authToken";
let apiAuthToken = initialAuthToken();
const mediaCacheKey = "caretv.media";
const playlistCacheKey = "caretv.playlists";
const theme = createTheme({
  primaryColor: "sage",
  colors: {
    sage: [
      "#f1f8f4",
      "#dceee4",
      "#b9dcc9",
      "#92c7aa",
      "#72b391",
      "#5ca47f",
      "#4c8f6e",
      "#3d7158",
      "#335b49",
      "#2b4b3d"
    ]
  },
  defaultRadius: "sm",
  fontFamily:
    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  headings: {
    fontFamily:
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  }
});

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
  startedAt?: string;
  completedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

interface PlaybackStatus {
  appliance?: { applianceId: string; name: string; connected: boolean; lastSeenAt: string };
  events: { id: string; type: string; createdAt: string; details: Record<string, unknown> }[];
  fallbackEnabled: boolean;
  loopEnabled: boolean;
  queue: QueueEntry[];
  remoteSupportUrl?: string;
  running: boolean;
  state?: {
    phase: string;
    queueEntryId?: string;
    mediaItemId?: string;
    title?: string;
    positionSeconds?: number;
    durationSeconds?: number;
    error?: { code: string; message: string };
  };
}

interface PlaybackLogEntry {
  id: string;
  createdAt: string;
  severity: "info" | "warning" | "error";
  source: "appliance" | "dashboard";
  type: string;
  title: string;
  mediaTitle?: string;
  description: string;
  details: Record<string, unknown>;
}

interface LogsResponse {
  since: string;
  entries: PlaybackLogEntry[];
}

interface Playlist {
  id: string;
  name: string;
  items: { mediaItemId: string; position: number }[];
  updatedAt: string;
}

interface FallbackResponse {
  playlist?: Playlist;
}

interface FallbackQueueItem {
  title: string;
  url: string;
}

type DashboardTab = "main" | "media" | "fallback" | "logs";

function App() {
  const [activeTab, setActiveTab] = useState<DashboardTab>("main");
  const [editingPlaylistId, setEditingPlaylistId] = useState<string>();
  const [fallbackDirty, setFallbackDirty] = useState(false);
  const fallbackDirtyRef = useRef(false);
  const [fallbackItems, setFallbackItems] = useState<FallbackQueueItem[]>([]);
  const [fallbackMessage, setFallbackMessage] = useState("");
  const [fallbackUrl, setFallbackUrl] = useState("");
  const [media, setMedia] = useState<MediaItem[]>(() => loadCachedArray<MediaItem>(mediaCacheKey));
  const [mediaSearch, setMediaSearch] = useState("");
  const [logs, setLogs] = useState<LogsResponse>();
  const [playlistMediaIds, setPlaylistMediaIds] = useState<string[]>([]);
  const [playlistName, setPlaylistName] = useState("New playlist");
  const [playlists, setPlaylists] = useState<Playlist[]>(() =>
    loadCachedArray<Playlist>(playlistCacheKey)
  );
  const [queueMessage, setQueueMessage] = useState("");
  const [status, setStatus] = useState<PlaybackStatus>();
  const [streamingUrl, setStreamingUrl] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [uploading, setUploading] = useState(false);
  const refreshSeq = useRef(0);
  const refreshInFlight = useRef(false);
  const logsRefreshInFlight = useRef(false);
  const logsRefreshSeq = useRef(0);

  async function refresh() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const seq = ++refreshSeq.current;
    try {
      const [mediaItems, playlistItems, playbackStatus, fallbackStatus] = await Promise.all([
        getJson<MediaItem[]>("/media"),
        getJson<Playlist[]>("/playlists"),
        getJson<PlaybackStatus>("/playback/status"),
        getJson<FallbackResponse>("/fallback/youtube")
      ]);

      if (seq !== refreshSeq.current) return;

      if (Array.isArray(mediaItems)) {
        setMedia(mediaItems);
        saveCachedArray(mediaCacheKey, mediaItems);
      }

      if (Array.isArray(playlistItems)) {
        setPlaylists(playlistItems);
        saveCachedArray(playlistCacheKey, playlistItems);
      }

      if (playbackStatus) {
        setStatus(playbackStatus);
      }

      if (fallbackStatus && !fallbackDirtyRef.current) {
        const currentMediaById = new Map((mediaItems ?? media).map((item) => [item.id, item]));
        setFallbackItems(fallbackItemsFromPlaylist(fallbackStatus.playlist, currentMediaById));
      }
    } finally {
      refreshInFlight.current = false;
    }
  }

  async function refreshLogs() {
    if (logsRefreshInFlight.current) return;
    logsRefreshInFlight.current = true;
    const seq = ++logsRefreshSeq.current;
    try {
      const logsStatus = await getJson<LogsResponse>("/logs");
      if (seq === logsRefreshSeq.current && logsStatus) {
        setLogs(logsStatus);
      }
    } finally {
      logsRefreshInFlight.current = false;
    }
  }

  useEffect(() => {
    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(), 3000);
    return () => {
      window.clearInterval(refreshTimer);
    };
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
  const playbackIssue = currentPlaybackIssue(status, mediaById);

  async function addStreamingItem() {
    setQueueMessage("");
    const path = streamingQueuePath(streamingUrl);

    if (!path) {
      setQueueMessage("Enter a YouTube or Amazon Prime Video URL.");
      return;
    }

    try {
      await apiPost(path, { url: streamingUrl });
      setStreamingUrl("");
    } catch {
      setQueueMessage("That streaming URL could not be added.");
    }
    await refresh();
  }

  async function openLogin(service: "prime" | "youtube", mediaItemId?: string) {
    setQueueMessage("");
    try {
      await apiPost(`/login/${service}`, mediaItemId ? { mediaItemId } : {});
      setQueueMessage(`Opened ${serviceLabel(service)} login on the appliance.`);
    } catch {
      setQueueMessage(`Could not open ${serviceLabel(service)} login.`);
    }
    await refresh();
  }

  async function uploadMedia(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    setQueueMessage("");
    try {
      await uploadFile(file, (progress) => setUploadProgress(progress));
      setQueueMessage(`Upload queued for appliance download: ${file.name}`);
      await refresh();
    } catch {
      setQueueMessage("Upload failed.");
    } finally {
      setUploading(false);
      setUploadProgress(undefined);
    }
  }

  async function enqueueMedia(mediaItemId: string) {
    setQueueMessage("");
    try {
      await apiPost("/queue", { mediaItemId });
      setQueueMessage("Item added to queue.");
    } catch {
      setQueueMessage("That item could not be queued.");
    }
    await refresh();
  }

  async function deleteMedia(mediaItemId: string) {
    setQueueMessage("");
    try {
      await request(`/media/${mediaItemId}`, { method: "DELETE" });
      removeMediaFromUi(mediaItemId);
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
      const saved = editingPlaylistId
        ? await postJson<Playlist>(`/playlists/${editingPlaylistId}`, body, "PUT")
        : await postJson<Playlist>("/playlists", body);
      upsertPlaylist(saved);
      if (editingPlaylistId) {
        setQueueMessage("Playlist updated.");
      } else {
        setQueueMessage("Playlist saved.");
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
      await apiPost(`/playlists/${id}/queue`, {});
      setQueueMessage("Playlist added to queue.");
    } catch {
      setQueueMessage("That playlist has no available media.");
    }
    await refresh();
  }

  async function deletePlaylist(id: string) {
    setQueueMessage("");
    try {
      await request(`/playlists/${id}`, { method: "DELETE" });
      if (editingPlaylistId === id) clearPlaylistBuilder();
      setQueueMessage("Playlist deleted.");
    } catch {
      setQueueMessage("Playlist could not be deleted.");
    }
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

  function upsertPlaylist(playlist: Playlist): void {
    setPlaylists((current) => {
      const next = [playlist, ...current.filter((candidate) => candidate.id !== playlist.id)];
      saveCachedArray(playlistCacheKey, next);
      return next;
    });
  }

  function setFallbackDraft(items: FallbackQueueItem[], dirty = true) {
    fallbackDirtyRef.current = dirty;
    setFallbackDirty(dirty);
    setFallbackItems(items);
  }

  function addFallbackItem() {
    setFallbackMessage("");

    if (!isYouTubeInput(fallbackUrl)) {
      setFallbackMessage("Enter a public YouTube URL.");
      return;
    }

    if (
      fallbackItems.some((item) => canonicalInputUrl(item.url) === canonicalInputUrl(fallbackUrl))
    ) {
      setFallbackMessage("That fallback video is already in the queue.");
      return;
    }

    setFallbackDraft([...fallbackItems, { title: "Public YouTube fallback", url: fallbackUrl }]);
    setFallbackUrl("");
  }

  function removeFallbackItem(index: number) {
    setFallbackDraft(fallbackItems.filter((_, itemIndex) => itemIndex !== index));
  }

  function moveFallbackItem(index: number, direction: "up" | "down") {
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    const current = fallbackItems[index];
    const neighbor = fallbackItems[nextIndex];

    if (!current || !neighbor) return;

    const next = [...fallbackItems];
    next[index] = neighbor;
    next[nextIndex] = current;
    setFallbackDraft(next);
  }

  async function discardFallbackChanges() {
    fallbackDirtyRef.current = false;
    setFallbackDirty(false);
    setFallbackMessage("");
    await refresh();
  }

  async function saveFallbackQueue() {
    setFallbackMessage("");
    try {
      await apiPost(
        "/fallback/youtube",
        {
          items: fallbackItems.map((item) => ({
            title: item.title,
            url: item.url
          }))
        },
        "PUT"
      );
      fallbackDirtyRef.current = false;
      setFallbackDirty(false);
      setFallbackMessage("Fallback queue saved.");
      await refresh();
    } catch {
      setFallbackMessage("Fallback queue could not be saved.");
    }
  }

  function togglePlaylistMedia(mediaItemId: string) {
    setPlaylistMediaIds((current) =>
      current.includes(mediaItemId)
        ? current.filter((id) => id !== mediaItemId)
        : [...current, mediaItemId]
    );
  }

  async function startPlayback() {
    setQueueMessage("");
    try {
      await apiPost("/playback/start", {});
      setQueueMessage("Playback start requested.");
    } catch {
      setQueueMessage("Playback could not be started.");
    }
    await refresh();
  }

  async function stopPlayback() {
    setQueueMessage("");
    try {
      await apiPost("/playback/stop", {});
      setQueueMessage("Playback stop requested.");
    } catch {
      setQueueMessage("Playback could not be stopped.");
    }
    await refresh();
  }

  async function resetLab() {
    setQueueMessage("");
    try {
      await apiPost("/lab/reset", {});
      setQueueMessage("Playback state and queue were reset.");
    } catch {
      setQueueMessage("Reset failed.");
    }
    await refresh();
  }

  async function sendCommand(type: "pause" | "restart" | "resume" | "skip") {
    setQueueMessage("");
    try {
      await apiPost("/commands", { type });
      setQueueMessage(`${commandLabel(type)} requested.`);
    } catch {
      setQueueMessage(`Could not send ${commandLabel(type).toLowerCase()}.`);
    }
    await refresh();
  }

  async function toggleLoop() {
    setQueueMessage("");
    try {
      await apiPost("/playback/loop", { enabled: !status?.loopEnabled });
      setQueueMessage(`Loop ${status?.loopEnabled ? "disabled" : "enabled"}.`);
    } catch {
      setQueueMessage("Loop setting could not be changed.");
    }
    await refresh();
  }

  async function toggleFallback() {
    setFallbackMessage("");
    try {
      await apiPost("/playback/fallback", { enabled: !status?.fallbackEnabled });
      setFallbackMessage(`Fallback queue ${status?.fallbackEnabled ? "disabled" : "enabled"}.`);
    } catch {
      setFallbackMessage("Fallback setting could not be changed.");
    }
    await refresh();
  }

  async function removeQueueEntry(id: string) {
    setQueueMessage("");
    try {
      await request(`/queue/${id}`, { method: "DELETE" });
      setStatus((current) =>
        current ? { ...current, queue: current.queue.filter((entry) => entry.id !== id) } : current
      );
      setQueueMessage("Queued item removed.");
    } catch {
      setQueueMessage("That queued item could not be removed.");
    }
    await refresh();
  }

  async function playQueueEntry(id: string) {
    setQueueMessage("");
    try {
      await apiPost(`/queue/${id}/play`, {});
      setQueueMessage("Selected item will play next.");
    } catch {
      setQueueMessage("That item cannot be played right now.");
    }
    await refresh();
  }

  async function moveQueueEntry(id: string, direction: "up" | "down") {
    setQueueMessage("");

    try {
      await apiPost(`/queue/${id}/move`, { direction });
      setStatus((current) => (current ? moveQueueInStatus(current, id, direction) : current));
      setQueueMessage("Queue reordered.");
      await refresh();
    } catch {
      setQueueMessage("That item is no longer movable. Stop playback, then reorder queued items.");
      await refresh();
    }
  }

  async function shuffleQueue() {
    setQueueMessage("");

    try {
      const result = await apiPost<{ queue: QueueEntry[] }>("/queue/shuffle", {});
      setStatus((current) => (current ? { ...current, queue: result.queue } : current));
      setQueueMessage("Queue randomized.");
    } catch {
      setQueueMessage("Queue could not be randomized.");
    }
    await refresh();
  }

  async function clearCompleted() {
    setQueueMessage("");
    try {
      await apiPost("/queue/clear-completed", {});
      setQueueMessage("Completed, failed, skipped, and cancelled items were cleared.");
    } catch {
      setQueueMessage("Completed items could not be cleared.");
    }
    await refresh();
  }

  async function clearErrors() {
    setQueueMessage("");
    try {
      await apiPost("/queue/clear-errors", {});
      setStatus((current) =>
        current
          ? {
              ...current,
              queue: current.queue.map(({ lastErrorCode, lastErrorMessage, ...entry }) => entry)
            }
          : current
      );
      setQueueMessage("Queue error messages were cleared.");
    } catch {
      setQueueMessage("Queue error messages could not be cleared.");
    }
    await refresh();
  }

  async function clearQueueSlate() {
    setQueueMessage("");
    setFallbackMessage("");
    try {
      await apiPost("/queue/clear-completed", {});
    } catch {
      setQueueMessage("Queue state could not be cleared.");
      return;
    }
    await refresh();
  }

  function removeMediaFromUi(mediaItemId: string) {
    const item = media.find((candidate) => candidate.id === mediaItemId);
    const ids = new Set(
      item?.localPath
        ? media.filter((candidate) => candidate.localPath === item.localPath).map(({ id }) => id)
        : [mediaItemId]
    );

    setMedia((current) => current.filter((candidate) => !ids.has(candidate.id)));
    setPlaylistMediaIds((current) => current.filter((id) => !ids.has(id)));
    setPlaylists((current) =>
      current.map((playlist) => ({
        ...playlist,
        items: playlist.items.filter((item) => !ids.has(item.mediaItemId))
      }))
    );
    setStatus((current) =>
      current
        ? { ...current, queue: current.queue.filter((entry) => !ids.has(entry.mediaItemId)) }
        : current
    );
  }

  return (
    <MantineProvider defaultColorScheme="dark" theme={theme}>
      <AppShell header={{ height: 74 }} padding="md">
        <AppShell.Header>
          <Container className="shell-header" fluid>
            <Box>
              <Text c="dimmed" fw={700} size="xs" tt="uppercase">
                CareTV
              </Text>
              <Title order={2}>Playback lab</Title>
            </Box>
            <Badge color={status?.running ? "sage" : "gray"} size="lg" variant="light">
              {status?.appliance?.connected ? status.appliance.name : "No appliance"}
            </Badge>
          </Container>
        </AppShell.Header>

        <AppShell.Main>
          <Container fluid maw={1480}>
            {playbackIssue ? (
              <Alert
                color="red"
                icon={<IconAlertTriangle size={18} />}
                mb="md"
                title={playbackIssue.title}
                variant="light"
              >
                <Group justify="space-between" wrap="wrap">
                  <Text>{playbackIssue.message}</Text>
                  <Group gap="xs">
                    {playbackIssue.queueEntryId ? (
                      <Button
                        leftSection={<IconRotateClockwise2 size={16} />}
                        size="xs"
                        variant="light"
                        onClick={() => void playQueueEntry(playbackIssue.queueEntryId!)}
                      >
                        Retry item
                      </Button>
                    ) : null}
                    {playbackIssue.service ? (
                      <Button
                        leftSection={<IconLogin2 size={16} />}
                        size="xs"
                        variant="light"
                        onClick={() =>
                          void openLogin(playbackIssue.service!, playbackIssue.mediaItemId)
                        }
                      >
                        Open {serviceLabel(playbackIssue.service)} login
                      </Button>
                    ) : null}
                    {status?.remoteSupportUrl ? (
                      <Button
                        component="a"
                        href={status.remoteSupportUrl}
                        leftSection={<IconExternalLink size={16} />}
                        size="xs"
                        target="_blank"
                        variant="light"
                      >
                        Remote support
                      </Button>
                    ) : null}
                  </Group>
                </Group>
              </Alert>
            ) : null}
            <Tabs value={activeTab} onChange={(value) => setActiveTab(value as DashboardTab)}>
              <Tabs.List mb="md">
                <Tabs.Tab value="main">Main</Tabs.Tab>
                <Tabs.Tab value="media">Media</Tabs.Tab>
                <Tabs.Tab value="fallback">Fallback</Tabs.Tab>
                <Tabs.Tab value="logs">Logs</Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="main">
                <Stack gap="md">
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
                    onClearErrors={() => void clearErrors()}
                    onClearSlate={() => void clearQueueSlate()}
                    onMove={(id, direction) => void moveQueueEntry(id, direction)}
                    onPlay={(id) => void playQueueEntry(id)}
                    onRemove={(id) => void removeQueueEntry(id)}
                    onReset={() => void resetLab()}
                    onShuffle={() => void shuffleQueue()}
                  />
                </Stack>
              </Tabs.Panel>

              <Tabs.Panel value="media">
                <Stack gap="md">
                  {queueMessage ? (
                    <Alert color="yellow" variant="light">
                      {queueMessage}
                    </Alert>
                  ) : null}
                  <Grid>
                    <Grid.Col span={{ base: 12, lg: 7 }}>
                      <MediaPanel
                        discoveredMedia={discoveredMedia}
                        mediaSearch={mediaSearch}
                        playlistMediaIds={playlistMediaIds}
                        uploadProgress={uploadProgress}
                        uploading={uploading}
                        onDelete={(id) => void deleteMedia(id)}
                        onEnqueue={(id) => void enqueueMedia(id)}
                        onSearchChange={setMediaSearch}
                        onTogglePlaylistMedia={togglePlaylistMedia}
                        onUpload={(file) => void uploadMedia(file)}
                      />
                    </Grid.Col>
                    <Grid.Col span={{ base: 12, lg: 5 }}>
                      <Stack gap="md">
                        <StreamingPanel
                          streamingUrl={streamingUrl}
                          onAdd={() => void addStreamingItem()}
                          onLogin={(service) => void openLogin(service)}
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
                          message=""
                          playlists={playlists}
                          onDelete={(id) => void deletePlaylist(id)}
                          onEdit={editPlaylist}
                          onQueue={(id) => void queuePlaylist(id)}
                        />
                      </Stack>
                    </Grid.Col>
                  </Grid>
                  <QueuePanel
                    mediaById={mediaById}
                    message={queueMessage}
                    queuedIds={queuedIds}
                    status={status}
                    onClearCompleted={() => void clearCompleted()}
                    onClearErrors={() => void clearErrors()}
                    onClearSlate={() => void clearQueueSlate()}
                    onMove={(id, direction) => void moveQueueEntry(id, direction)}
                    onPlay={(id) => void playQueueEntry(id)}
                    onRemove={(id) => void removeQueueEntry(id)}
                    onReset={() => void resetLab()}
                    onShuffle={() => void shuffleQueue()}
                  />
                </Stack>
              </Tabs.Panel>

              <Tabs.Panel value="fallback">
                <FallbackPanel
                  dirty={fallbackDirty}
                  fallbackEnabled={status?.fallbackEnabled ?? true}
                  items={fallbackItems}
                  message={fallbackMessage}
                  {...(status?.remoteSupportUrl
                    ? { remoteSupportUrl: status.remoteSupportUrl }
                    : {})}
                  url={fallbackUrl}
                  onAdd={addFallbackItem}
                  onDiscard={() => void discardFallbackChanges()}
                  onFallbackToggle={() => void toggleFallback()}
                  onMove={moveFallbackItem}
                  onRemove={removeFallbackItem}
                  onSave={() => void saveFallbackQueue()}
                  onUrlChange={setFallbackUrl}
                />
              </Tabs.Panel>

              <Tabs.Panel value="logs">
                <LogsPanel logs={logs} onRefresh={() => void refreshLogs()} />
              </Tabs.Panel>
            </Tabs>
          </Container>
        </AppShell.Main>
      </AppShell>
    </MantineProvider>
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
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="md">
        <Group justify="space-between" align="start">
          <Box>
            <Title order={3}>{props.state?.title ?? "Nothing playing"}</Title>
            <Text c="dimmed" size="sm">
              {props.state?.phase ?? "idle"}
            </Text>
          </Box>
          <Badge color={props.status?.running ? "sage" : "gray"} variant="light">
            {props.status?.running ? "Playback enabled" : "Playback stopped"}
          </Badge>
        </Group>
        <Paper className="screen" radius="md" p="xl">
          <Title className="screen-title" order={1}>
            {props.state?.title ?? "CareTV output"}
          </Title>
          <Text c="gray.4" fw={600}>
            {props.state?.phase ?? "Waiting for queue"}
          </Text>
          <Progress value={props.progress} color="sage" radius="xl" size="md" />
          <Text c="gray.4" fw={600} size="sm">
            {props.state?.positionSeconds ?? 0}s / {props.state?.durationSeconds ?? 0}s
          </Text>
        </Paper>
        {props.state?.error ? (
          <Alert color="red" variant="light">
            {props.state.error.code}: {props.state.error.message}
          </Alert>
        ) : null}
        <Group gap="xs">
          <Button leftSection={<IconPlayerPlay size={16} />} onClick={() => props.onStart()}>
            Start
          </Button>
          <Button
            leftSection={<IconPlayerPause size={16} />}
            variant="light"
            onClick={() => props.onCommand("pause")}
          >
            Pause
          </Button>
          <Button variant="light" onClick={() => props.onCommand("resume")}>
            Resume
          </Button>
          <Button
            leftSection={<IconRotateClockwise2 size={16} />}
            variant="light"
            onClick={() => props.onCommand("restart")}
          >
            Rewind
          </Button>
          <Button
            leftSection={<IconPlayerSkipForward size={16} />}
            variant="light"
            onClick={() => props.onCommand("skip")}
          >
            Skip
          </Button>
          <Button
            color={props.status?.loopEnabled ? "sage" : "gray"}
            leftSection={<IconRepeat size={16} />}
            variant={props.status?.loopEnabled ? "filled" : "light"}
            onClick={() => props.onLoop()}
          >
            Loop
          </Button>
          <Button color="red" variant="light" onClick={() => props.onStop()}>
            Stop
          </Button>
        </Group>
        <Text c="dimmed" fw={600} size="sm">
          {props.status?.appliance?.connected
            ? `Connected ${new Date(props.status.appliance.lastSeenAt).toLocaleTimeString()}`
            : "Appliance offline"}
        </Text>
      </Stack>
    </Card>
  );
}

function QueuePanel(props: {
  mediaById: Map<string, MediaItem>;
  message: string;
  queuedIds: string[];
  status: PlaybackStatus | undefined;
  onClearCompleted: () => void;
  onClearErrors: () => void;
  onClearSlate: () => void;
  onMove: (id: string, direction: "up" | "down") => void;
  onPlay: (id: string) => void;
  onRemove: (id: string) => void;
  onReset: () => void;
  onShuffle: () => void;
}) {
  const visibleQueue =
    props.status?.queue.filter((entry) => isVisibleQueueEntry(entry, props.mediaById)) ?? [];
  const durationSummary = queueDurationSummary(visibleQueue, props.mediaById, props.status?.state);
  const errorCount = visibleQueue.filter(
    (entry) => entry.lastErrorCode || entry.lastErrorMessage
  ).length;
  const terminalCount = visibleQueue.filter((entry) => isTerminalQueueStatus(entry.status)).length;
  const queuedCount = visibleQueue.filter((entry) => entry.status === "queued").length;

  return (
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <Title order={3}>Queue</Title>
            {visibleQueue.length ? <Badge variant="light">{visibleQueue.length}</Badge> : null}
          </Group>
          <Group gap="xs">
            <Button
              disabled={queuedCount < 2}
              leftSection={<IconRepeat size={16} />}
              size="xs"
              variant="light"
              onClick={() => props.onShuffle()}
            >
              Shuffle
            </Button>
            <Button
              disabled={terminalCount === 0 && !props.message}
              leftSection={<IconEraser size={16} />}
              size="xs"
              variant="light"
              onClick={() => props.onClearSlate()}
            >
              Clean slate
            </Button>
            <Button
              color="red"
              disabled={errorCount === 0}
              leftSection={<IconEraser size={16} />}
              size="xs"
              variant="light"
              onClick={() => props.onClearErrors()}
            >
              Clear errors
            </Button>
            <Button size="xs" variant="light" onClick={() => props.onClearCompleted()}>
              Clear done
            </Button>
            <Button color="red" size="xs" variant="light" onClick={() => props.onReset()}>
              Reset lab
            </Button>
          </Group>
        </Group>
        {visibleQueue.length ? (
          <Group gap="md">
            <Text c="dimmed" fw={700} size="sm">
              Total playing time:{" "}
              <Text component="span" c="var(--mantine-color-text)">
                {durationSummary.total}
              </Text>
            </Text>
            <Text c="dimmed" fw={700} size="sm">
              Playing time left:{" "}
              <Text component="span" c="var(--mantine-color-text)">
                {durationSummary.remaining}
              </Text>
            </Text>
          </Group>
        ) : null}
        {props.message ? (
          <Alert color="yellow" variant="light">
            {props.message}
          </Alert>
        ) : null}
        {visibleQueue.length ? (
          <ScrollArea.Autosize mah={520}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Title</Table.Th>
                  <Table.Th>Source</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visibleQueue.map((entry) => (
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
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        ) : (
          <Text c="dimmed">No queued items yet.</Text>
        )}
      </Stack>
    </Card>
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
  const canRemove = props.entry.status === "queued" || isTerminalQueueStatus(props.entry.status);
  const disabledReason = props.running
    ? "Stop playback before reordering."
    : "Only queued items with a queued neighbor can move.";
  const playedFor = playedDurationText(props.entry);
  const expectedDuration = formatDuration(trustedDurationSeconds(props.media));

  return (
    <Table.Tr>
      <Table.Td>
        <Text fw={600}>
          {props.media?.title ?? props.entry.mediaItemId}
          {expectedDuration ? ` (${expectedDuration})` : ""}
        </Text>
        <Text c="dimmed" size="sm">
          #{props.entry.position}
        </Text>
        {props.entry.lastErrorCode ? (
          <Text c="red" lineClamp={2} mt={4} size="sm">
            {props.entry.lastErrorCode}
            {props.entry.lastErrorMessage ? `: ${props.entry.lastErrorMessage}` : ""}
          </Text>
        ) : null}
      </Table.Td>
      <Table.Td>
        <Badge color="gray" variant="light">
          {scenarioLabel(props.media)}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Badge color={statusColor(props.entry.status)} variant={statusVariant(props.entry.status)}>
          {props.entry.status}
        </Badge>
        {playedFor ? (
          <Text c="dimmed" mt={4} size="xs">
            Played for {playedFor}
          </Text>
        ) : null}
      </Table.Td>
      <Table.Td>
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {canPlay ? (
            <ActionIcon
              aria-label="Play this item next"
              color="sage"
              variant="light"
              onClick={() => props.onPlay(props.entry.id)}
            >
              <IconPlayerPlay size={16} />
            </ActionIcon>
          ) : null}
          {props.entry.status === "queued" ? (
            <>
              <ActionIcon
                aria-label="Move up"
                disabled={props.running || !canMoveUp}
                title={canMoveUp && !props.running ? "Move up" : disabledReason}
                variant="light"
                onClick={() => props.onMove(props.entry.id, "up")}
              >
                <IconArrowUp size={16} />
              </ActionIcon>
              <ActionIcon
                aria-label="Move down"
                disabled={props.running || !canMoveDown}
                title={canMoveDown && !props.running ? "Move down" : disabledReason}
                variant="light"
                onClick={() => props.onMove(props.entry.id, "down")}
              >
                <IconArrowDown size={16} />
              </ActionIcon>
              <ActionIcon
                aria-label="Remove"
                color="red"
                variant="light"
                onClick={() => props.onRemove(props.entry.id)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </>
          ) : null}
          {canRemove && props.entry.status !== "queued" ? (
            <ActionIcon
              aria-label="Remove"
              color="red"
              variant="light"
              onClick={() => props.onRemove(props.entry.id)}
            >
              <IconTrash size={16} />
            </ActionIcon>
          ) : null}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function MediaPanel(props: {
  discoveredMedia: MediaItem[];
  mediaSearch: string;
  playlistMediaIds: string[];
  uploadProgress: number | undefined;
  uploading: boolean;
  onDelete: (id: string) => void;
  onEnqueue: (id: string) => void;
  onSearchChange: (value: string) => void;
  onTogglePlaylistMedia: (id: string) => void;
  onUpload: (file: File | undefined) => void;
}) {
  return (
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={3}>Discovered media</Title>
          <FileButton
            accept="video/mp4,.mp4"
            onChange={(file) => props.onUpload(file ?? undefined)}
          >
            {(fileProps) => (
              <Button
                {...fileProps}
                leftSection={<IconUpload size={16} />}
                loading={props.uploading}
                size="xs"
                variant="light"
              >
                Upload
              </Button>
            )}
          </FileButton>
        </Group>
        {props.uploading && props.uploadProgress !== undefined ? (
          <Progress aria-label="Upload progress" value={props.uploadProgress} striped animated />
        ) : null}
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder="Search discovered media"
          value={props.mediaSearch}
          onChange={(event) => props.onSearchChange(event.currentTarget.value)}
        />
        {props.discoveredMedia.length ? (
          <ScrollArea.Autosize mah={520}>
            <Stack gap="xs">
              {props.discoveredMedia.map((item) => (
                <Paper className="media-row-card" key={item.id} p="sm" radius="md" withBorder>
                  <Group align="center" justify="space-between" wrap="nowrap">
                    <Group gap="sm" wrap="nowrap">
                      <Checkbox
                        aria-label={`Add ${item.title} to playlist`}
                        checked={props.playlistMediaIds.includes(item.id)}
                        onChange={() => props.onTogglePlaylistMedia(item.id)}
                      />
                      <Box className="truncate">
                        <Text fw={600} truncate="end">
                          {item.title}
                        </Text>
                        <Text c="dimmed" size="sm" truncate="end">
                          {mediaSourceLabel(item)}
                        </Text>
                      </Box>
                    </Group>
                    <Group gap={6} wrap="nowrap">
                      <Button
                        disabled={item.service === "local" && !item.localPath}
                        size="xs"
                        title={
                          item.service !== "local" || item.localPath
                            ? "Add to queue"
                            : "Waiting for appliance download"
                        }
                        onClick={() => props.onEnqueue(item.id)}
                      >
                        Queue
                      </Button>
                      <ActionIcon
                        aria-label="Delete media"
                        color="red"
                        variant="light"
                        onClick={() => props.onDelete(item.id)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Group>
                </Paper>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        ) : (
          <Text c="dimmed">No discovered media matches.</Text>
        )}
      </Stack>
    </Card>
  );
}

function StreamingPanel(props: {
  streamingUrl: string;
  onAdd: () => void;
  onLogin: (service: "prime" | "youtube") => void;
  onUrlChange: (value: string) => void;
}) {
  return (
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="sm">
        <Title order={3}>Add streaming item</Title>
        <TextInput
          label="URL"
          placeholder="YouTube or Amazon Prime Video URL"
          value={props.streamingUrl}
          onChange={(event) => props.onUrlChange(event.currentTarget.value)}
        />
        <Button leftSection={<IconPlus size={16} />} onClick={() => props.onAdd()}>
          Add to queue
        </Button>
        <Group grow gap="xs">
          <Button
            leftSection={<IconLogin2 size={16} />}
            variant="light"
            onClick={() => props.onLogin("youtube")}
          >
            YouTube login
          </Button>
          <Button
            leftSection={<IconLogin2 size={16} />}
            variant="light"
            onClick={() => props.onLogin("prime")}
          >
            Prime login
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

function FallbackPanel(props: {
  dirty: boolean;
  fallbackEnabled: boolean;
  items: FallbackQueueItem[];
  message: string;
  remoteSupportUrl?: string;
  url: string;
  onAdd: () => void;
  onDiscard: () => void;
  onFallbackToggle: () => void;
  onMove: (index: number, direction: "up" | "down") => void;
  onRemove: (index: number) => void;
  onSave: () => void;
  onUrlChange: (value: string) => void;
}) {
  return (
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="md">
        <Group justify="space-between" align="start">
          <Box>
            <Title order={3}>YouTube fallback queue</Title>
            <Text c="dimmed" size="sm">
              Public videos the appliance queues when account-gated YouTube playback is blocked.
            </Text>
          </Box>
          <Badge color={props.dirty ? "yellow" : "gray"} variant="light">
            {props.dirty ? "Unsaved" : "Saved"}
          </Badge>
        </Group>

        <Group justify="space-between" wrap="wrap">
          <Checkbox
            checked={props.fallbackEnabled}
            label="Enable fallback queue"
            onChange={() => props.onFallbackToggle()}
          />
          {props.remoteSupportUrl ? (
            <Button
              component="a"
              href={props.remoteSupportUrl}
              leftSection={<IconExternalLink size={16} />}
              size="xs"
              target="_blank"
              variant="light"
            >
              Remote support
            </Button>
          ) : null}
        </Group>

        {props.message ? (
          <Alert color={props.message.includes("saved") ? "teal" : "yellow"} variant="light">
            {props.message}
          </Alert>
        ) : null}

        <Group align="end" grow>
          <TextInput
            label="Public YouTube URL"
            placeholder="https://www.youtube.com/watch?v=..."
            value={props.url}
            onChange={(event) => props.onUrlChange(event.currentTarget.value)}
          />
          <Button leftSection={<IconPlus size={16} />} onClick={() => props.onAdd()}>
            Add
          </Button>
        </Group>

        {props.items.length ? (
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Order</Table.Th>
                <Table.Th>Video</Table.Th>
                <Table.Th ta="right">Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.items.map((item, index) => (
                <Table.Tr key={`${item.url}-${index}`}>
                  <Table.Td>#{index + 1}</Table.Td>
                  <Table.Td>
                    <Text fw={600}>{item.title}</Text>
                    <Text c="dimmed" size="sm" truncate="end">
                      {item.url}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <ActionIcon
                        aria-label="Move fallback item up"
                        disabled={index === 0}
                        variant="light"
                        onClick={() => props.onMove(index, "up")}
                      >
                        <IconArrowUp size={16} />
                      </ActionIcon>
                      <ActionIcon
                        aria-label="Move fallback item down"
                        disabled={index === props.items.length - 1}
                        variant="light"
                        onClick={() => props.onMove(index, "down")}
                      >
                        <IconArrowDown size={16} />
                      </ActionIcon>
                      <ActionIcon
                        aria-label="Remove fallback item"
                        color="red"
                        variant="light"
                        onClick={() => props.onRemove(index)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Text c="dimmed">No fallback videos saved.</Text>
        )}

        <Group justify="flex-end">
          <Button disabled={!props.dirty} variant="light" onClick={() => props.onDiscard()}>
            Discard changes
          </Button>
          <Button disabled={!props.dirty} onClick={() => props.onSave()}>
            Save fallback queue
          </Button>
        </Group>
      </Stack>
    </Card>
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
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={3}>{props.editing ? "Edit playlist" : "Create playlist"}</Title>
          <Button size="xs" variant="light" onClick={() => props.onClear()}>
            New
          </Button>
        </Group>
        <TextInput
          label="Name"
          value={props.name}
          onChange={(event) => props.onNameChange(event.currentTarget.value)}
        />
        <Paper p="sm" radius="md" withBorder>
          {props.selectedIds.length ? (
            <Stack gap={6}>
              {props.selectedIds.map((id, index) => (
                <Group key={id} justify="space-between" wrap="nowrap">
                  <Text className="truncate" size="sm">
                    {index + 1}. {props.mediaById.get(id)?.title ?? id}
                  </Text>
                  <Button size="compact-xs" variant="subtle" onClick={() => props.onRemove(id)}>
                    Remove
                  </Button>
                </Group>
              ))}
            </Stack>
          ) : (
            <Text c="dimmed" size="sm">
              Select media items from the list.
            </Text>
          )}
        </Paper>
        <Button onClick={() => props.onSave()}>Save playlist</Button>
      </Stack>
    </Card>
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
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="sm">
        <Title order={3}>Playlists</Title>
        {props.message ? (
          <Alert color="yellow" variant="light">
            {props.message}
          </Alert>
        ) : null}
        {props.playlists.length ? (
          <Stack gap="xs">
            {props.playlists.map((playlist) => (
              <Paper key={playlist.id} p="sm" radius="md" withBorder>
                <Group justify="space-between" wrap="nowrap">
                  <Box className="truncate">
                    <Text fw={600}>{playlist.name}</Text>
                    <Text c="dimmed" size="sm" truncate="end">
                      {playlistSummary(playlist, props.mediaById)}
                    </Text>
                  </Box>
                  <Group gap={6} wrap="nowrap">
                    <Button size="xs" variant="light" onClick={() => props.onQueue(playlist.id)}>
                      Add to queue
                    </Button>
                    <Button size="xs" variant="light" onClick={() => props.onEdit(playlist)}>
                      Edit
                    </Button>
                    <ActionIcon
                      aria-label="Delete playlist"
                      color="red"
                      variant="light"
                      onClick={() => props.onDelete(playlist.id)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Group>
              </Paper>
            ))}
          </Stack>
        ) : (
          <Text c="dimmed">No playlists yet.</Text>
        )}
      </Stack>
    </Card>
  );
}

function LogsPanel(props: { logs: LogsResponse | undefined; onRefresh: () => void }) {
  const errorCount = props.logs?.entries.filter((entry) => entry.severity === "error").length ?? 0;

  return (
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="md">
        <Group justify="space-between" align="start">
          <Box>
            <Title order={3}>24-hour logs</Title>
            <Text c="dimmed" size="sm">
              Playback activity, commands, buffering, and failures from the last 24 hours.
            </Text>
          </Box>
          <Group gap="xs">
            <Badge color={errorCount ? "red" : "sage"} variant="light">
              {errorCount} errors
            </Badge>
            <Button
              leftSection={<IconRotateClockwise2 size={16} />}
              size="xs"
              variant="light"
              onClick={props.onRefresh}
            >
              Load logs
            </Button>
          </Group>
        </Group>

        {props.logs?.entries.length ? (
          <ScrollArea.Autosize mah={620}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Time</Table.Th>
                  <Table.Th>Level</Table.Th>
                  <Table.Th>Source</Table.Th>
                  <Table.Th>What happened</Table.Th>
                  <Table.Th>Details</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {props.logs.entries.map((entry) => (
                  <Table.Tr key={entry.id}>
                    <Table.Td className="log-time">
                      {new Date(entry.createdAt).toLocaleString()}
                    </Table.Td>
                    <Table.Td>
                      <Badge color={severityColor(entry.severity)} variant="light">
                        {entry.severity}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={entry.source === "dashboard" ? "blue" : "gray"} variant="light">
                        {entry.source}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text fw={700} size="sm">
                        {entry.title}
                      </Text>
                      <Text size="sm">{entry.description}</Text>
                      {entry.mediaTitle ? (
                        <Text c="dimmed" size="xs">
                          {entry.mediaTitle}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      <Text className="log-details" component="code" size="xs">
                        {formatLogDetails(entry.details)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        ) : (
          <Text c="dimmed">No logs in the last 24 hours.</Text>
        )}
      </Stack>
    </Card>
  );
}

async function apiPost<T = void>(
  path: string,
  body: Record<string, unknown>,
  method = "POST"
): Promise<T> {
  return postJson<T>(path, body, method);
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  method = "POST"
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    body: JSON.stringify(body),
    headers: authHeaders({ "content-type": "application/json" }),
    method
  });

  if (response.status === 401 && promptForAuthToken()) return postJson<T>(path, body, method);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return (await response.json()) as T;
}

function uploadFile(file: File, onProgress: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase}/uploads?filename=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    if (apiAuthToken) xhr.setRequestHeader("authorization", `Bearer ${apiAuthToken}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else if (xhr.status === 401 && promptForAuthToken()) {
        uploadFile(file, onProgress).then(resolve, reject);
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed."));
    xhr.onabort = () => reject(new Error("Upload aborted."));
    xhr.send(file);
  });
}

async function request(path: string, init: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: authHeaders(init.headers)
  });
  if (response.status === 401 && promptForAuthToken()) return request(path, init);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
}

async function getJson<T>(path: string): Promise<T | undefined> {
  try {
    const response = await fetch(`${apiBase}${path}`, {
      cache: "no-store",
      headers: authHeaders()
    });
    if (response.status === 401 && promptForAuthToken()) return getJson<T>(path);
    return response.ok ? ((await response.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

function initialAuthToken(): string | undefined {
  const token = new URLSearchParams(window.location.search).get("token")?.trim();
  if (token) {
    window.localStorage.setItem(authTokenKey, token);
    window.history.replaceState(null, "", window.location.pathname);
    return token;
  }

  return window.localStorage.getItem(authTokenKey)?.trim() || undefined;
}

function promptForAuthToken(): boolean {
  const token = window.prompt("CareTV auth token")?.trim();
  if (!token) return false;

  apiAuthToken = token;
  window.localStorage.setItem(authTokenKey, token);
  return true;
}

function authHeaders(headers?: HeadersInit): HeadersInit {
  return {
    ...Object.fromEntries(new Headers(headers).entries()),
    ...(apiAuthToken ? { authorization: `Bearer ${apiAuthToken}` } : {})
  };
}

function loadCachedArray<T>(key: string): T[] {
  try {
    const value = window.localStorage.getItem(key);
    const parsed = value ? (JSON.parse(value) as unknown) : undefined;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function saveCachedArray<T>(key: string, values: T[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(values));
  } catch {
    return;
  }
}

function severityColor(severity: PlaybackLogEntry["severity"]): string {
  if (severity === "error") return "red";
  if (severity === "warning") return "yellow";
  return "gray";
}

function formatLogDetails(details: Record<string, unknown>): string {
  const visible = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${String(value)}`);

  return visible.length ? visible.join(" | ") : "-";
}

function scenarioLabel(item: MediaItem | undefined): string {
  if (item?.service === "prime" || item?.service === "youtube") return item.service;
  const scenario = item?.metadata.scenario;
  return typeof scenario === "string" ? scenario : "unknown";
}

function statusColor(status: string): string {
  if (status === "playing") return "green";
  if (status === "starting") return "sage";
  if (status === "failed") return "red";
  if (status === "paused") return "indigo";
  if (status === "skipped" || status === "cancelled") return "gray";
  return "orange";
}

function statusVariant(status: string): "filled" | "light" {
  return status === "playing" ? "filled" : "light";
}

function isVisibleQueueEntry(entry: QueueEntry, mediaById: Map<string, MediaItem>): boolean {
  return mediaById.has(entry.mediaItemId);
}

function isTerminalQueueStatus(status: string): boolean {
  return ["completed", "failed", "skipped", "cancelled"].includes(status);
}

function queueDurationSummary(
  queue: QueueEntry[],
  mediaById: Map<string, MediaItem>,
  state: PlaybackStatus["state"] | undefined
): { remaining: string; total: string } {
  const total = queue.reduce(
    (summary, entry) =>
      addDuration(
        summary,
        queueEntryDurationSeconds(entry, mediaById.get(entry.mediaItemId), state)
      ),
    emptyDurationSummary()
  );
  const remaining = queue.reduce(
    (summary, entry) =>
      addDuration(summary, remainingQueueSeconds(entry, mediaById.get(entry.mediaItemId), state)),
    emptyDurationSummary()
  );

  return {
    remaining: formatDurationSummary(remaining),
    total: formatDurationSummary(total)
  };
}

function remainingQueueSeconds(
  entry: QueueEntry,
  media: MediaItem | undefined,
  state: PlaybackStatus["state"] | undefined
): number | undefined {
  const duration = queueEntryExpectedDurationSeconds(entry, media, state);

  if (isTerminalQueueStatus(entry.status) || entry.status === "cancelled") {
    return 0;
  }

  if (entry.status === "playing" || entry.status === "starting" || entry.status === "paused") {
    if (!duration) return undefined;
    const position =
      (state?.queueEntryId === entry.id || state?.mediaItemId === entry.mediaItemId) &&
      typeof state.positionSeconds === "number"
        ? state.positionSeconds
        : 0;
    return Math.max(0, duration - position);
  }

  return entry.status === "queued" ? duration : 0;
}

function queueEntryDurationSeconds(
  entry: QueueEntry,
  media: MediaItem | undefined,
  state: PlaybackStatus["state"] | undefined
): number | undefined {
  if (isTerminalQueueStatus(entry.status)) {
    return playedDurationSeconds(entry) ?? queueEntryExpectedDurationSeconds(entry, media, state);
  }

  return queueEntryExpectedDurationSeconds(entry, media, state);
}

function queueEntryExpectedDurationSeconds(
  entry: QueueEntry,
  media: MediaItem | undefined,
  state: PlaybackStatus["state"] | undefined
): number | undefined {
  if (
    (state?.queueEntryId === entry.id || state?.mediaItemId === entry.mediaItemId) &&
    typeof state.durationSeconds === "number" &&
    Number.isFinite(state.durationSeconds)
  ) {
    return Math.max(1, Math.floor(state.durationSeconds));
  }

  return trustedDurationSeconds(media);
}

function emptyDurationSummary(): { seconds: number; unknown: number } {
  return { seconds: 0, unknown: 0 };
}

function addDuration(
  summary: { seconds: number; unknown: number },
  seconds: number | undefined
): { seconds: number; unknown: number } {
  return seconds === undefined
    ? { ...summary, unknown: summary.unknown + 1 }
    : { ...summary, seconds: summary.seconds + seconds };
}

function formatDurationSummary(summary: { seconds: number; unknown: number }): string {
  const known = formatDuration(summary.seconds);
  const unknown = summary.unknown
    ? `${summary.unknown} unknown ${summary.unknown === 1 ? "item" : "items"}`
    : "";

  if (known && unknown) return `${known} + ${unknown}`;
  return known || unknown || "0s";
}

function trustedDurationSeconds(media: MediaItem | undefined): number | undefined {
  if (!media?.expectedDurationSeconds) {
    return undefined;
  }

  if (
    media.service === "youtube" &&
    media.expectedDurationSeconds === 900 &&
    media.metadata.durationObserved !== 1
  ) {
    return undefined;
  }

  return media.expectedDurationSeconds;
}

function playedDurationText(entry: QueueEntry): string | undefined {
  if (
    !["completed", "failed", "skipped"].includes(entry.status) ||
    !entry.startedAt ||
    !entry.completedAt
  ) {
    return undefined;
  }

  return formatDuration(playedDurationSeconds(entry));
}

function playedDurationSeconds(entry: QueueEntry): number | undefined {
  if (!entry.startedAt || !entry.completedAt) return undefined;
  return Math.max(
    0,
    Math.round((new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime()) / 1000)
  );
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (seconds <= 0) return "0s";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60);
  const remainingMinutes = minutes % 60;
  const remainingSeconds = Math.round(seconds % 60);

  if (hours) return `${hours}h ${remainingMinutes}m`;
  return minutes ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function currentPlaybackIssue(
  status: PlaybackStatus | undefined,
  mediaById: Map<string, MediaItem>
):
  | {
      message: string;
      mediaItemId?: string;
      queueEntryId?: string;
      service?: "prime" | "youtube";
      title: string;
    }
  | undefined {
  const stateError = status?.state?.error;

  if (stateError) {
    const media = status?.state?.mediaItemId ? mediaById.get(status.state.mediaItemId) : undefined;
    const active = status?.queue.find(
      (entry) =>
        entry.mediaItemId === status.state?.mediaItemId &&
        ["starting", "playing", "paused", "failed"].includes(entry.status)
    );
    return playbackIssueFor(stateError.code, stateError.message, media, active?.id);
  }

  return undefined;
}

function playbackIssueFor(
  code: string,
  message: string,
  media: MediaItem | undefined,
  queueEntryId?: string
):
  | {
      message: string;
      mediaItemId?: string;
      queueEntryId?: string;
      service?: "prime" | "youtube";
      title: string;
    }
  | undefined {
  const service =
    media?.service === "youtube" || media?.service === "prime" ? media.service : undefined;

  if (code.startsWith("youtube-")) {
    const title = media?.title
      ? `YouTube needs attention: ${media.title}`
      : "YouTube needs attention";

    if (
      [
        "youtube-signin-required",
        "youtube-age-verification-required",
        "youtube-verification-required"
      ].includes(code)
    ) {
      return {
        message: `${friendlyIssueCode(code)}. Open the YouTube login on the appliance, complete the prompt, then requeue the item.`,
        ...(media ? { mediaItemId: media.id } : {}),
        ...(queueEntryId ? { queueEntryId } : {}),
        service: "youtube",
        title
      };
    }

    if (code === "youtube-consent-required") {
      return {
        message:
          "YouTube is showing a consent prompt. Open the YouTube login on the appliance and clear the prompt.",
        ...(media ? { mediaItemId: media.id } : {}),
        ...(queueEntryId ? { queueEntryId } : {}),
        service: "youtube",
        title
      };
    }

    if (code === "youtube-buffering-timeout") {
      return {
        message: "YouTube stayed buffered too long. Retry the item or let the queue continue.",
        ...(queueEntryId ? { queueEntryId } : {}),
        service: "youtube",
        title
      };
    }
  }

  if (service === "prime" && code.includes("signin")) {
    return {
      message: `${message} Open the Prime login on the appliance, complete the prompt, then requeue the item.`,
      ...(queueEntryId ? { queueEntryId } : {}),
      service: "prime",
      title: media?.title ? `Prime needs attention: ${media.title}` : "Prime needs attention"
    };
  }

  return undefined;
}

function friendlyIssueCode(code: string): string {
  switch (code) {
    case "youtube-signin-required":
      return "YouTube is signed out";
    case "youtube-age-verification-required":
      return "YouTube requires age verification";
    case "youtube-verification-required":
      return "Google requires account verification";
    default:
      return code;
  }
}

function uploadStatus(item: MediaItem): string {
  const upload = item.metadata.upload;
  return upload && typeof upload === "object" && "status" in upload
    ? `upload ${String(upload.status)}`
    : "waiting for appliance";
}

function fallbackItemsFromPlaylist(
  playlist: Playlist | undefined,
  mediaById: Map<string, MediaItem>
): FallbackQueueItem[] {
  return (
    playlist?.items
      .sort((a, b) => a.position - b.position)
      .map((item) => mediaById.get(item.mediaItemId))
      .filter((item): item is MediaItem => Boolean(item?.url))
      .map((item) => ({
        title: item.title,
        url: item.url!
      })) ?? []
  );
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

function isYouTubeInput(input: string): boolean {
  try {
    const host = new URL(input).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

function canonicalInputUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    return url.href;
  } catch {
    return input.trim();
  }
}

function mediaSourceLabel(item: MediaItem): string {
  return item.service === "local" ? (item.localPath ?? uploadStatus(item)) : item.service;
}

function serviceLabel(service: "prime" | "youtube"): string {
  return service === "prime" ? "Prime" : "YouTube";
}

function commandLabel(type: "pause" | "restart" | "resume" | "skip"): string {
  switch (type) {
    case "pause":
      return "Pause";
    case "restart":
      return "Rewind";
    case "resume":
      return "Resume";
    case "skip":
      return "Skip";
  }
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
