import * as restate from "@restatedev/restate-sdk";

import {
  approvalGrantsForGroup,
  automationMatchesPublication,
  publicationGroupsById,
  validateAutomationRunRequest,
  type AutomationApproval,
  type AutomationApprovalResponse,
  type AutomationPublisher,
  type AutomationRunRequest,
  type AutomationRunResult,
  type AutomationRunStatus,
  type AutomationStepResult,
} from "@blogmaatic/automation";
import type { DeliveryReceipt } from "@blogmaatic/core";

const STATUS_KEY = "status";
const WORKFLOW_NAME = "BlogmaaticPublicationAutomation";

export interface PublicationAutomationWorkflowOptions {
  readonly publisher: AutomationPublisher;
  readonly workflowName?: string;
  /**
   * Publisher exceptions fail terminal by default so permanent auth/configuration
   * errors are not retried forever. Return true only for errors known to be transient.
   * Explicit `unreachable` delivery receipts remain retryable regardless.
   */
  readonly isRetryablePublisherError?: (error: unknown) => boolean;
}

function approvalPromiseKey(stepId: string): string {
  return `approval:${stepId}`;
}

function businessFailure(receipts: readonly DeliveryReceipt[]): boolean {
  return receipts.length === 0 || receipts.some((receipt) => receipt.status !== "verified");
}

function transientFailure(receipts: readonly DeliveryReceipt[]): boolean {
  return receipts.some((receipt) => receipt.status === "unreachable");
}

function businessFailureDetail(receipts: readonly DeliveryReceipt[]): string {
  if (receipts.length === 0) return "Publication group produced no delivery receipts";
  return receipts
    .filter((receipt) => receipt.status !== "verified")
    .map((receipt) => `${receipt.routeId}:${receipt.status}`)
    .join(", ");
}

async function durableNow(ctx: restate.WorkflowContext, label: string): Promise<string> {
  return ctx.run(`clock:${label}`, () => new Date().toISOString());
}

function setStatus(ctx: restate.WorkflowContext, status: AutomationRunStatus): void {
  ctx.set(STATUS_KEY, status);
}

async function makeStatus(
  ctx: restate.WorkflowContext,
  request: AutomationRunRequest,
  phase: AutomationRunStatus["phase"],
  completedStepIds: readonly string[],
  options: {
    readonly currentStepId?: string;
    readonly detail?: string;
    readonly expectedApproval?: AutomationRunStatus["expectedApproval"];
  } = {},
): Promise<AutomationRunStatus> {
  const updatedAt = await durableNow(ctx, `${phase}:${options.currentStepId ?? "run"}:${completedStepIds.length}`);
  return {
    runId: request.runId,
    automationId: request.definition.id,
    automationVersion: request.definition.version,
    publicationId: request.publication.id,
    revisionId: request.publication.current.id,
    phase,
    completedStepIds,
    ...(options.currentStepId ? { currentStepId: options.currentStepId } : {}),
    ...(options.expectedApproval ? { expectedApproval: options.expectedApproval } : {}),
    ...(options.detail ? { detail: options.detail } : {}),
    updatedAt,
  };
}

async function finish(
  ctx: restate.WorkflowContext,
  request: AutomationRunRequest,
  outcome: AutomationRunResult["outcome"],
  stepResults: readonly AutomationStepResult[],
  completedStepIds: readonly string[],
  detail?: string,
): Promise<AutomationRunResult> {
  const phase = outcome === "completed" ? "completed" : outcome === "rejected" ? "rejected" : "stopped";
  const status = await makeStatus(ctx, request, phase, completedStepIds, detail ? { detail } : {});
  setStatus(ctx, status);
  return {
    runId: request.runId,
    automationId: request.definition.id,
    publicationId: request.publication.id,
    revisionId: request.publication.current.id,
    outcome,
    stepResults,
    completedAt: status.updatedAt,
    ...(detail ? { detail } : {}),
  };
}

export function createPublicationAutomationWorkflow(options: PublicationAutomationWorkflowOptions) {
  const name = options.workflowName ?? WORKFLOW_NAME;

  return restate.workflow({
    name,
    handlers: {
      run: async (ctx: restate.WorkflowContext, request: AutomationRunRequest): Promise<AutomationRunResult> => {
        try {
          validateAutomationRunRequest(request);
        } catch (error) {
          throw new restate.TerminalError(error instanceof Error ? error.message : "Invalid automation run request");
        }
        if (ctx.key !== request.runId) {
          throw new restate.TerminalError(`Workflow key ${ctx.key} does not match run id ${request.runId}`);
        }

        if (!automationMatchesPublication(request.definition, request.publication, request.trigger)) {
          return finish(ctx, request, "stopped", [], [], "Automation trigger or publication conditions did not match");
        }

        const groups = publicationGroupsById(request.groups);
        const approvals: AutomationApproval[] = [];
        const stepResults: AutomationStepResult[] = [];
        const completedStepIds: string[] = [];

        setStatus(ctx, await makeStatus(ctx, request, "running", completedStepIds));

        for (const step of request.definition.steps) {
          if (step.kind === "approval") {
            const expectedApproval = {
              stepId: step.id,
              role: step.role,
              revisionId: request.publication.current.id,
            };
            setStatus(
              ctx,
              await makeStatus(ctx, request, "waiting_approval", completedStepIds, {
                currentStepId: step.id,
                expectedApproval,
                ...(step.prompt ? { detail: step.prompt } : {}),
              }),
            );

            const approval = await ctx.promise<AutomationApproval>(approvalPromiseKey(step.id));
            if (
              approval.runId !== request.runId ||
              approval.stepId !== step.id ||
              approval.revisionId !== request.publication.current.id ||
              approval.role !== step.role
            ) {
              throw new restate.TerminalError(`Approval payload does not match step ${step.id}`);
            }
            approvals.push(approval);
            completedStepIds.push(step.id);
            stepResults.push({
              stepId: step.id,
              kind: "approval",
              outcome: approval.decision === "approve" ? "approved" : "rejected",
              approval,
            });

            if (approval.decision === "reject") {
              return finish(
                ctx,
                request,
                "rejected",
                stepResults,
                completedStepIds,
                approval.note ?? `Approval step ${step.id} was rejected`,
              );
            }

            setStatus(
              ctx,
              await makeStatus(ctx, request, "running", completedStepIds, { currentStepId: step.id }),
            );
            continue;
          }

          if (step.kind === "delay") {
            setStatus(
              ctx,
              await makeStatus(ctx, request, "delaying", completedStepIds, {
                currentStepId: step.id,
                detail: `Durable delay for ${step.durationMs}ms`,
              }),
            );
            await ctx.sleep({ milliseconds: step.durationMs });
            completedStepIds.push(step.id);
            stepResults.push({
              stepId: step.id,
              kind: "delay",
              outcome: "completed",
              durationMs: step.durationMs,
            });
            setStatus(
              ctx,
              await makeStatus(ctx, request, "running", completedStepIds, { currentStepId: step.id }),
            );
            continue;
          }

          const group = groups.get(step.groupId);
          if (!group) {
            throw new restate.TerminalError(`Automation group disappeared after validation: ${step.groupId}`);
          }

          setStatus(
            ctx,
            await makeStatus(ctx, request, "running", completedStepIds, {
              currentStepId: step.id,
              detail: `Publishing group ${group.name}`,
            }),
          );

          const grants = approvalGrantsForGroup(group, request.publication, approvals);
          const receipts = await ctx.run(`publish:${step.id}`, async () => {
            let result: readonly DeliveryReceipt[];
            try {
              result = await options.publisher.publishGroup({
                publication: request.publication,
                group,
                approvals: grants,
              });
            } catch (error) {
              if (options.isRetryablePublisherError?.(error)) throw error;
              throw new restate.TerminalError(
                `Publisher step ${step.id} failed and was not classified as retryable`,
              );
            }
            if (transientFailure(result)) {
              throw new Error(`Transient publication failure in group ${group.id}`);
            }
            return result;
          });

          const failed = businessFailure(receipts);
          completedStepIds.push(step.id);
          stepResults.push({
            stepId: step.id,
            kind: "publish_group",
            groupId: group.id,
            outcome: failed ? "business_failure" : "verified",
            receipts,
          });

          if (failed && (step.onBusinessFailure ?? "stop") === "stop") {
            return finish(
              ctx,
              request,
              "stopped",
              stepResults,
              completedStepIds,
              `Publication group ${group.id} stopped the automation: ${businessFailureDetail(receipts)}`,
            );
          }
        }

        return finish(ctx, request, "completed", stepResults, completedStepIds);
      },

      approve: restate.handlers.workflow.shared(async (
        ctx: restate.WorkflowSharedContext,
        approval: AutomationApproval,
      ): Promise<AutomationApprovalResponse> => {
        if (approval.runId !== ctx.key) {
          return { accepted: false, reason: `Approval run id ${approval.runId} does not match workflow ${ctx.key}` };
        }
        if (approval.decision !== "approve" && approval.decision !== "reject") {
          return { accepted: false, reason: "Approval decision must be approve or reject" };
        }

        const status = await ctx.get<AutomationRunStatus>(STATUS_KEY);
        if (!status || status.phase !== "waiting_approval" || !status.expectedApproval) {
          return { accepted: false, reason: "Automation is not waiting for approval" };
        }
        if (
          status.expectedApproval.stepId !== approval.stepId ||
          status.expectedApproval.role !== approval.role ||
          status.expectedApproval.revisionId !== approval.revisionId
        ) {
          return { accepted: false, reason: "Approval does not match the current step, role, and revision" };
        }

        await ctx.promise<AutomationApproval>(approvalPromiseKey(approval.stepId)).resolve(approval);
        return { accepted: true };
      }),

      status: restate.handlers.workflow.shared(async (
        ctx: restate.WorkflowSharedContext,
      ): Promise<AutomationRunStatus | null> => ctx.get<AutomationRunStatus>(STATUS_KEY)),
    },
  });
}

export type PublicationAutomationWorkflow = ReturnType<typeof createPublicationAutomationWorkflow>;
