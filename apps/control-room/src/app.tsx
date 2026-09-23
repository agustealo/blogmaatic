import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";

import { ConnectScreen, useConnection } from "./connection";
import { AppShell } from "./shell";
import { ApprovalsPage } from "./pages/approvals";
import { AuditPage } from "./pages/audit";
import { AutomationsPage } from "./pages/automations";
import { ConnectionsPage } from "./pages/connections";
import { OperationsPage } from "./pages/operations";
import { OverviewPage } from "./pages/overview";
import { RunDetailPage, RunsPage } from "./pages/runs";
import { SchedulesPage } from "./pages/schedules";
import { FirstRunEntry, SetupPage } from "./pages/setup";

function gated(page: ReactNode) {
  return <FirstRunEntry ready={page} />;
}

export function App() {
  const { session } = useConnection();
  if (!session) return <ConnectScreen />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="setup" element={<SetupPage />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route index element={gated(<OverviewPage />)} />
        <Route path="operations" element={gated(<OperationsPage />)} />
        <Route path="approvals" element={gated(<ApprovalsPage />)} />
        <Route path="runs" element={gated(<RunsPage />)} />
        <Route path="runs/:runId" element={gated(<RunDetailPage />)} />
        <Route path="automations" element={gated(<AutomationsPage />)} />
        <Route path="automations/:automationId" element={gated(<AutomationsPage />)} />
        <Route path="schedules" element={gated(<SchedulesPage />)} />
        <Route path="audit" element={gated(<AuditPage />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
