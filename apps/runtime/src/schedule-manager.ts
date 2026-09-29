import {
  addMilliseconds,
  type AutomationSchedule,
  type ControlPlaneStore,
} from "@blogmaatic/control-plane";

export interface ScheduleManagerOptions {
  readonly store: ControlPlaneStore;
  readonly now?: () => string;
}

export class ScheduleManager {
  readonly #store: ControlPlaneStore;
  readonly #now: () => string;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: ScheduleManagerOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async setEnabled(
    scheduleId: string,
    expectedUpdatedAt: string,
    enabled: boolean,
  ): Promise<AutomationSchedule> {
    if (!scheduleId.trim()) throw new Error("Schedule id is required");
    if (!expectedUpdatedAt.trim()) throw new Error("Schedule expectedUpdatedAt is required");

    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    try {
      const current = await this.#store.getSchedule(scheduleId);
      if (!current) throw new Error(`Schedule is not registered: ${scheduleId}`);
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new Error(
          `Schedule ${scheduleId} changed from ${expectedUpdatedAt} to ${current.updatedAt}`,
        );
      }

      if (enabled) {
        const automation = await this.#store.getAutomationVersion(
          current.automationId,
          current.automationVersion,
        );
        if (!automation || !automation.enabled || !automation.isActiveVersion) {
          throw new Error(
            `Schedule ${scheduleId} cannot be enabled because Automation ${current.automationId} v${current.automationVersion} is not the enabled active version`,
          );
        }
        if (automation.definition.trigger.kind !== "schedule") {
          throw new Error(`Schedule ${scheduleId} references an Automation that is not schedule-triggered`);
        }
        if (current.nextFireAt === null) {
          throw new Error(`Schedule ${scheduleId} has no future fire and cannot be re-enabled`);
        }
      }

      let updatedAt = new Date(this.#now()).toISOString();
      if (updatedAt === current.updatedAt) updatedAt = addMilliseconds(updatedAt, 1);
      const next: AutomationSchedule = { ...current, enabled, updatedAt };
      await this.#store.putSchedule(next);
      const stored = await this.#store.getSchedule(scheduleId);
      if (!stored) throw new Error(`Schedule ${scheduleId} disappeared after activation update`);
      return stored;
    } finally {
      release();
    }
  }
}
