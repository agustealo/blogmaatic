import { Navigate, Route, Routes } from "react-router";

import { ConnectScreen, useConnection } from "./connection";
import { AppShell } from "./shell";
import { ApprovalsPage } from "./pages/approvals";
import { AuditPage } from "./pages/audit";
import { AutomationsPage } from "./pages/automations";
import { OperationsPage } from "./pages/operations";
import { OverviewPage } from "./pages/overview";
import { RunDetailPage, RunsPage } from "./pages/runs";
import { SchedulesPage } from "./pages/schedules";

export function App() {
  const { session } = useConnection();
  if (!session) return <ConnectScreen />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="automations" element={<AutomationsPage />} />
        <Route path="automations/:automationId" element={<AutomationsPage />} />
        <Route path="schedules" element={<SchedulesPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
