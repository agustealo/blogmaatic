import type {
  AutomationSchedule,
  OperatorOperation,
  Page,
} from "@blogmaatic/operator-client";

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatInstant(value: string | null | undefined): string {
  if (!value) return "Not set";
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : dateTime.format(timestamp);
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function pageCount(page: Page<unknown>): string {
  return `${page.items.length}${page.nextCursor ? "+" : ""}`;
}

export function recurrenceLabel(schedule: AutomationSchedule): string {
  if (schedule.recurrence.kind === "once") return "Once";
  if (schedule.recurrence.kind === "daily") return "Daily";
  return `Weekly · ${schedule.recurrence.weekdays.join(", ")}`;
}

export function operationTitle(operation: OperatorOperation): string {
  switch (operation.kind) {
    case "approval_required": return "Approval required";
    case "launch_failed": return "Launch failed";
    case "run_stopped": return "Run stopped";
    case "run_rejected": return "Run rejected";
    case "delivery_blocked": return "Delivery blocked";
    case "delivery_awaiting_approval": return "Delivery awaiting approval";
    case "delivery_drifted": return "Remote drift detected";
    case "delivery_unreachable": return "Destination unreachable";
  }
}

export function triggerLabel(kind: string): string {
  return kind === "manual" ? "Manual" : kind === "event" ? "Event" : kind === "schedule" ? "Schedule" : humanize(kind);
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
