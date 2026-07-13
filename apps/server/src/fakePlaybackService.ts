import { FakeStreamingAdapter } from "@caretv/adapters";
import type { PlaybackState } from "@caretv/core";
import type {
  CommandRepository,
  MediaRepository,
  PlaybackEventRepository,
  QueueRepository
} from "@caretv/database";
import { PlaybackAgent } from "@caretv/playback-agent";
import type { AgentRunResult } from "@caretv/playback-agent";

interface FakePlaybackServiceOptions {
  commands: CommandRepository;
  events: PlaybackEventRepository;
  logger: Console;
  media: MediaRepository;
  queue: QueueRepository;
}

export interface PlaybackServiceStatus {
  lastResult?: AgentRunResult;
  running: boolean;
  state?: PlaybackState;
}

export class FakePlaybackService {
  private lastResult: AgentRunResult | undefined;
  private loop: Promise<void> | undefined;
  private running = false;
  private state: PlaybackState | undefined;

  public constructor(private readonly options: FakePlaybackServiceOptions) {}

  public start(): PlaybackServiceStatus {
    if (!this.loop) {
      this.running = true;
      this.loop = this.runLoop().finally(() => {
        this.loop = undefined;
        this.running = false;
      });
    }

    return this.status();
  }

  public stop(): PlaybackServiceStatus {
    this.running = false;
    return this.status();
  }

  public status(): PlaybackServiceStatus {
    return {
      running: this.running,
      ...(this.state ? { state: this.state } : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {})
    };
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const agent = new PlaybackAgent({
        adapters: [new FakeStreamingAdapter()],
        commands: this.options.commands,
        events: this.options.events,
        logger: this.options.logger,
        maxObservations: 600,
        media: this.options.media,
        observeIntervalMs: 1000,
        onStateChange: (state) => {
          this.state = state;
        },
        queue: this.options.queue
      });

      const result = await agent.runOnce();
      this.state = agent.getState();

      if (result.status === "idle") {
        this.running = false;
        return;
      }

      this.lastResult = result;
    }
  }
}
