import type { AutomationControlPlane } from "@blogmaatic/control-plane";

export class SchedulerLoop {
  readonly #controlPlane: AutomationControlPlane;
  readonly #pollMs: number;
  readonly #batchSize: number;
  readonly #onError: (error: Error) => void;
  #timer: NodeJS.Timeout | undefined;
  #active: Promise<void> | undefined;
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
    this.#beginTick();
  }

  #beginTick(): void {
    if (this.#stopped || this.#active) return;
    const active = this.#dispatch();
    this.#active = active;
    void active.finally(() => {
      if (this.#active === active) this.#active = undefined;
      if (!this.#stopped) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          this.#beginTick();
        }, this.#pollMs);
        this.#timer.unref();
      }
    });
  }

  async #dispatch(): Promise<void> {
    try {
      await this.#controlPlane.dispatchDueSchedules({ limit: this.#batchSize });
    } catch (error) {
      this.#onError(error instanceof Error ? error : new Error("Scheduler dispatch failed"));
    }
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const active = this.#active;
    if (active) await active;
  }
}
