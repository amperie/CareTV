import { join } from "node:path";

import { FakeStreamingAdapter } from "@caretv/adapters";
import { loadConfig } from "@caretv/config";
import {
  CommandRepository,
  MediaRepository,
  migrate,
  openDatabase,
  PlaybackEventRepository,
  QueueRepository
} from "@caretv/database";
import { PlaybackAgent } from "@caretv/playback-agent";

const config = loadConfig();
const db = openDatabase(join(config.values.runtimeDir, "caretv.sqlite"));
migrate(db);

const agent = new PlaybackAgent({
  adapters: [new FakeStreamingAdapter()],
  commands: new CommandRepository(db),
  events: new PlaybackEventRepository(db),
  logger: console,
  media: new MediaRepository(db),
  queue: new QueueRepository(db)
});

const result = await agent.runOnce();
console.log(JSON.stringify(result));

db.close();
