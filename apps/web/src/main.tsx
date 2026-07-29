import { StrictMode, useEffect, useMemo, useState } from "react";
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
  Title
} from "@mantine/core";
import "@mantine/core/styles.css";
import {
  IconArrowDown,
  IconArrowUp,
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

const apiBase = `http://${window.location.hostname}:4010/api/v1`;
const mediaCacheKey = "caretv.media";
const playlistCacheKey = "caretv.playlists";

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
  const [editingPlaylistId, setEditingPlaylistId] = useState<string>();
  const [media, setMedia] = useState<MediaItem[]>(() => loadCachedArray<MediaItem>(mediaCacheKey));
  const [mediaSearch, setMediaSearch] = useState("");
  const [playlistMediaIds, setPlaylistMediaIds] = useState<string[]>([]);
  const [playlistName, setPlaylistName] = useState("New playlist");
  const [playlists, setPlaylists] = useState<Playlist[]>(() =>
    loadCachedArray<Playlist>(playlistCacheKey)
  );
  const [queueMessage, setQueueMessage] = useState("");
  const [status, setStatus] = useState<PlaybackStatus>();
  const [streamingUrl, setStreamingUrl] = useState("");
  const [uploading, setUploading] = useState(false);

  async function refresh() {
    const [mediaItems, playlistItems, playbackStatus] = await Promise.all([
      getJson<MediaItem[]>("/media"),
      getJson<Playlist[]>("/playlists"),
      getJson<PlaybackStatus>("/playback/status")
    ]);

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

  async function openLogin(service: "prime" | "youtube") {
    setQueueMessage("");
    try {
      await post(`/login/${service}`, {});
      setQueueMessage(`Opened ${serviceLabel(service)} login on the appliance.`);
    } catch {
      setQueueMessage(`Could not open ${serviceLabel(service)} login.`);
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
    } catch {
      setQueueMessage("Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function enqueueMedia(mediaItemId: string) {
    setQueueMessage("");
    try {
      await post("/queue", { mediaItemId });
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
      setQueueMessage("Playlist saved.");
    } catch {
      setQueueMessage("Playlist could not be saved.");
    }
    await refresh();
  }

  async function queuePlaylist(id: string) {
    setQueueMessage("");
    try {
      await post(`/playlists/${id}/queue`, {});
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
      await post("/playback/start", {});
      setQueueMessage("Playback start requested.");
    } catch {
      setQueueMessage("Playback could not be started.");
    }
    await refresh();
  }

  async function stopPlayback() {
    setQueueMessage("");
    try {
      await post("/playback/stop", {});
      setQueueMessage("Playback stop requested.");
    } catch {
      setQueueMessage("Playback could not be stopped.");
    }
    await refresh();
  }

  async function resetLab() {
    setQueueMessage("");
    try {
      await post("/lab/reset", {});
      setQueueMessage("Playback state and queue were reset.");
    } catch {
      setQueueMessage("Reset failed.");
    }
    await refresh();
  }

  async function sendCommand(type: "pause" | "restart" | "resume" | "skip") {
    setQueueMessage("");
    try {
      await post("/commands", { type });
      setQueueMessage(`${commandLabel(type)} requested.`);
    } catch {
      setQueueMessage(`Could not send ${commandLabel(type).toLowerCase()}.`);
    }
    await refresh();
  }

  async function toggleLoop() {
    setQueueMessage("");
    try {
      await post("/playback/loop", { enabled: !status?.loopEnabled });
      setQueueMessage(`Loop ${status?.loopEnabled ? "disabled" : "enabled"}.`);
    } catch {
      setQueueMessage("Loop setting could not be changed.");
    }
    await refresh();
  }

  async function removeQueueEntry(id: string) {
    setQueueMessage("");
    try {
      await request(`/queue/${id}`, { method: "DELETE" });
      setQueueMessage("Queued item removed.");
    } catch {
      setQueueMessage("That queued item could not be removed.");
    }
    await refresh();
  }

  async function playQueueEntry(id: string) {
    setQueueMessage("");
    try {
      await post(`/queue/${id}/play`, {});
      setQueueMessage("Selected item will play next.");
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
      setQueueMessage("Queue reordered.");
      await refresh();
    } catch {
      setQueueMessage("That item is no longer movable. Stop playback, then reorder queued items.");
      await refresh();
    }
  }

  async function clearCompleted() {
    setQueueMessage("");
    try {
      await post("/queue/clear-completed", {});
      setQueueMessage("Completed, failed, skipped, and cancelled items were cleared.");
    } catch {
      setQueueMessage("Completed items could not be cleared.");
    }
    await refresh();
  }

  return (
    <MantineProvider defaultColorScheme="light">
      <AppShell header={{ height: 74 }} padding="md">
        <AppShell.Header>
          <Container className="shell-header" fluid>
            <Box>
              <Text c="dimmed" fw={700} size="xs" tt="uppercase">
                CareTV
              </Text>
              <Title order={2}>Playback lab</Title>
            </Box>
            <Badge color={status?.running ? "teal" : "gray"} size="lg" variant="light">
              {status?.appliance?.connected ? status.appliance.name : "No appliance"}
            </Badge>
          </Container>
        </AppShell.Header>

        <AppShell.Main>
          <Container fluid maw={1480}>
            <Tabs value={activeTab} onChange={(value) => setActiveTab(value as DashboardTab)}>
              <Tabs.List mb="md">
                <Tabs.Tab value="main">Main</Tabs.Tab>
                <Tabs.Tab value="media">Media</Tabs.Tab>
                <Tabs.Tab value="events">Events</Tabs.Tab>
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
                    onMove={(id, direction) => void moveQueueEntry(id, direction)}
                    onPlay={(id) => void playQueueEntry(id)}
                    onRemove={(id) => void removeQueueEntry(id)}
                    onReset={() => void resetLab()}
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
                    onMove={(id, direction) => void moveQueueEntry(id, direction)}
                    onPlay={(id) => void playQueueEntry(id)}
                    onRemove={(id) => void removeQueueEntry(id)}
                    onReset={() => void resetLab()}
                  />
                </Stack>
              </Tabs.Panel>

              <Tabs.Panel value="events">
                <EventsPanel status={status} />
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
          <Badge color={props.status?.running ? "teal" : "gray"} variant="light">
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
          <Progress value={props.progress} color="teal" radius="xl" size="md" />
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
            color={props.status?.loopEnabled ? "blue" : "gray"}
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
  onMove: (id: string, direction: "up" | "down") => void;
  onPlay: (id: string) => void;
  onRemove: (id: string) => void;
  onReset: () => void;
}) {
  return (
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <Title order={3}>Queue</Title>
            {props.status?.queue.length ? (
              <Badge variant="light">{props.status.queue.length}</Badge>
            ) : null}
          </Group>
          <Group gap="xs">
            <Button size="xs" variant="light" onClick={() => props.onClearCompleted()}>
              Clear done
            </Button>
            <Button color="red" size="xs" variant="light" onClick={() => props.onReset()}>
              Reset lab
            </Button>
          </Group>
        </Group>
        {props.message ? (
          <Alert color="yellow" variant="light">
            {props.message}
          </Alert>
        ) : null}
        {props.status?.queue.length ? (
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
                {props.status.queue.map((entry) => (
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
  const disabledReason = props.running
    ? "Stop playback before reordering."
    : "Only queued items with a queued neighbor can move.";

  return (
    <Table.Tr>
      <Table.Td>
        <Text fw={600}>{props.media?.title ?? props.entry.mediaItemId}</Text>
        <Text c="dimmed" size="sm">
          #{props.entry.position}
        </Text>
        {props.entry.lastErrorCode ? (
          <Text c="red" size="sm">
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
        <Badge color={statusColor(props.entry.status)} variant="light">
          {props.entry.status}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {canPlay ? (
            <ActionIcon
              aria-label="Play this item next"
              color="teal"
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
        </Group>
      </Table.Td>
    </Table.Tr>
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
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={3}>Discovered media</Title>
          <FileButton
            accept="video/*,.mkv,.avi"
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
                    <Button size="xs" onClick={() => props.onQueue(playlist.id)}>
                      Queue
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

function EventsPanel(props: { status: PlaybackStatus | undefined }) {
  return (
    <Card withBorder radius="md" shadow="xs">
      <Stack gap="sm">
        <Title order={3}>Output events</Title>
        {props.status?.events.length ? (
          <ScrollArea.Autosize mah={620}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Time</Table.Th>
                  <Table.Th>Event</Table.Th>
                  <Table.Th>Details</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {props.status.events.map((event) => (
                  <Table.Tr key={event.id}>
                    <Table.Td>{new Date(event.createdAt).toLocaleTimeString()}</Table.Td>
                    <Table.Td>
                      <Badge color={event.type === "FAILED" ? "red" : "gray"} variant="light">
                        {event.type}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text component="code" size="sm">
                        {formatDetail(event.details.from)} -&gt; {formatDetail(event.details.to)}
                        {event.type === "FAILED" ? ` (${formatDetail(event.details.code)})` : ""}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        ) : (
          <Text c="dimmed">No events yet.</Text>
        )}
      </Stack>
    </Card>
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

async function getJson<T>(path: string): Promise<T | undefined> {
  try {
    const response = await fetch(`${apiBase}${path}`, { cache: "no-store" });
    return response.ok ? ((await response.json()) as T) : undefined;
  } catch {
    return undefined;
  }
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

function statusColor(status: string): string {
  if (status === "playing" || status === "starting") return "teal";
  if (status === "failed") return "red";
  if (status === "paused") return "blue";
  if (status === "skipped" || status === "cancelled") return "gray";
  return "yellow";
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
