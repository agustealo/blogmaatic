import { useCallback, useState } from "react";

import type { ScheduleListQuery } from "@blogmaatic/operator-client";

import { useConnection } from "../connection";
import { CollectionFooter, EmptyState, ErrorBanner, LoadingBlock, PageHeader, Panel, StatusPill } from "../components";
import { formatInstant, recurrenceLabel } from "../format";
import { usePagedCollection } from "../hooks";

export function SchedulesPage() {
  const { session } = useConnection();
  const [enabled, setEnabled] = useState<"" | "true" | "false">("");
  const loader = useCallback((cursor?: string) => {
    if (!session) return Promise.resolve({ items: [] });
    const query: ScheduleListQuery = {
      limit: 30,
      ...(enabled ? { enabled: enabled === "true" } : {}),
      ...(cursor ? { cursor } : {}),
    };
    return session.client.listSchedules(query);
  }, [enabled, session]);
  const collection = usePagedCollection(`schedules:${enabled}`, loader);

  return (
    <>
      <PageHeader eyebrow="Calendar authority" title="Schedules" description="Timezone-aware durable schedule snapshots and their next eligible fires. Dispatch is intentionally not automatic from this screen." />
      <div className="toolbar"><label className="field field--inline"><span>State</span><select value={enabled} onChange={(event) => setEnabled(event.target.value as typeof enabled)}><option value="">All schedules</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label><button className="button button--quiet" type="button" onClick={() => void collection.reload()}>Refresh</button></div>
      <ErrorBanner error={collection.error} />
      {collection.loading ? <LoadingBlock /> : (
        <Panel className="table-panel">
          <div className="data-table data-table--schedules">
            <div className="data-table__head"><span>Schedule</span><span>Automation</span><span>Local time</span><span>Next fire</span><span>State</span></div>
            {collection.items.map((schedule) => (
              <div className="data-table__row" key={schedule.id}>
                <span><strong>{schedule.id}</strong><small>{recurrenceLabel(schedule)}</small></span>
                <span><strong>{schedule.automationId}</strong><small>v{schedule.automationVersion}</small></span>
                <span><strong>{schedule.localDate} · {schedule.localTime}</strong><small>{schedule.timezone}</small></span>
                <span><strong>{formatInstant(schedule.nextFireAt)}</strong>{schedule.lastFireAt ? <small>Last {formatInstant(schedule.lastFireAt)}</small> : null}</span>
                <span><StatusPill value={schedule.enabled ? "enabled" : "disabled"} /></span>
              </div>
            ))}
          </div>
          {collection.items.length === 0 ? <EmptyState title="No matching schedules">No durable schedule matches the selected state.</EmptyState> : null}
        </Panel>
      )}
      <CollectionFooter hasMore={Boolean(collection.nextCursor)} busy={collection.loadingMore} onLoadMore={() => void collection.loadMore()} />
    </>
  );
}
