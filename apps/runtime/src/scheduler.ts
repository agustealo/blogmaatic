import type { AutomationControlPlane } from "@blogmaatic/control-plane";

export class SchedulerLoop {
  readonly #controlPlane: AutomationControlPlane;
  readonly #pollMs: number;
  readonly #batchSize: number;
  readonly #onError: (error: Error) => void;
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;

  constructor(options: {
    readonly controlPlane: AutomationControlPlane;
    readonly pollMs: number;
    readonly batchSize: number;
    readonly onError?: (error: Error) => void;
  }) {
    this.#controlPlane = options.controlPlane;
    this.#pollMs = options.pollMs;
    this.#batchSize = options.batchSize;
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#tick();
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#controlPlane.dispatchDueSchedules({ limit: this.#batchSize });
    } catch (error) {
      this.#onError(error instanceof Error ? error : new Error("Scheduler dispatch failed"));
    }
    if (!this.#stopped) {
      this.#timer = setTimeout(() => void this.#tick(), this.#pollMs);
      this.#timer.unref();
    }
  }

  close(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
