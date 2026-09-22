import type {
  RestateWorkflowContext,
  RestateWorkflowSharedContext,
} from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";

import type {
  AutomationApproval,
  AutomationApprovalResponse,
  AutomationRunRequest,
  AutomationRunResult,
  AutomationRunStatus,
} from "@blogmaatic/automation";

type PublicationAutomationClientHandlers = {
  run(
    ctx: RestateWorkflowContext,
    request: AutomationRunRequest,
  ): Promise<AutomationRunResult>;
  approve(
    ctx: RestateWorkflowSharedContext,
    approval: AutomationApproval,
  ): Promise<AutomationApprovalResponse>;
  status(ctx: RestateWorkflowSharedContext): Promise<AutomationRunStatus | null>;
};

export interface RestateAutomationLauncherOptions {
  readonly url: string;
  readonly workflowName?: string;
}

export class RestateAutomationLauncher {
  readonly #ingress: clients.Ingress;
  readonly #workflowName: string;

  constructor(options: RestateAutomationLauncherOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Restate ingress URL must use HTTP or HTTPS");
    }
    this.#workflowName = options.workflowName ?? "BlogmaaticPublicationAutomation";
    if (!this.#workflowName.trim()) throw new Error("Restate automation workflow name is required");
    this.#ingress = clients.connect({ url: url.toString().replace(/\/$/, "") });
  }

  #client(runId: string) {
    if (!runId.trim()) throw new Error("Automation run id is required");
    return this.#ingress.workflowClient<PublicationAutomationClientHandlers>(
      { name: this.#workflowName },
      runId,
    );
  }

  async start(request: AutomationRunRequest): Promise<{ readonly runtimeId: string }> {
    const submission = await this.#client(request.runId).workflowSubmit(request);
    return { runtimeId: submission.invocationId };
  }

  async status(runId: string): Promise<AutomationRunStatus | null> {
    return this.#client(runId).status();
  }

  async approve(approval: AutomationApproval): Promise<AutomationApprovalResponse> {
    return this.#client(approval.runId).approve(approval);
  }

  async result(runId: string): Promise<AutomationRunResult> {
    return this.#client(runId).workflowAttach();
  }
}
