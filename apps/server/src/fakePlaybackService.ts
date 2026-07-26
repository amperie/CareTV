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
  loopEnabled: boolean;
  running: boolean;
  state?: PlaybackState;
}

export class FakePlaybackService {
  private lastResult: AgentRunResult | undefined;
  private loopEnabled = false;
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

  public reset(): PlaybackServiceStatus {
    this.running = false;
    this.lastResult = undefined;
    this.state = undefined;
    return this.status();
  }

  public setLoop(enabled: boolean): PlaybackServiceStatus {
    this.loopEnabled = enabled;
    return this.status();
  }

  public status(): PlaybackServiceStatus {
    return {
      loopEnabled: this.loopEnabled,
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
        if (this.loopEnabled && this.options.queue.requeueCompletedEntries() > 0) {
          continue;
        }

        this.running = false;
        return;
      }

      this.lastResult = result;
    }
  }
}
