export type DesktopApproval = {
  id: string;
  taskId: string;
  executionId?: string | null;
  deviceId: string;
  kind: "command" | "fileWrite" | "permission" | "externalWrite";
  reason: string;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  scope?: "once" | "taskSession" | null;
  expiresAtMs?: number | null;
};

export type DesktopApprovalEvent = {
  eventId: string;
  type: string;
};

export type DesktopApprovalBackend = {
  getPendingApprovals: () => Promise<readonly DesktopApproval[]>;
  decideApproval: (input: {
    approvalId: string;
    decision: "approve" | "deny";
    scope: "once" | "taskSession";
    clientRequestId: string;
    idempotencyKey: string;
  }) => Promise<DesktopApproval>;
};

const maxSeenEvents = 256;

export function approvalDecisionKey(
  approvalId: string,
  decision: "approve" | "deny",
  scope: "once" | "taskSession"
): string {
  return `approval-decision:${approvalId}:${decision}:${scope}`;
}

export class DesktopApprovalFeed {
  private readonly approvalById = new Map<string, DesktopApproval>();
  private readonly seenEvents = new Set<string>();
  private refreshGeneration = 0;
  private disposed = false;

  public constructor(private readonly backend: DesktopApprovalBackend) {}

  public get approvals(): readonly DesktopApproval[] {
    return [...this.approvalById.values()]
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  public async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const approvals = await this.backend.getPendingApprovals();
    if (this.disposed || generation !== this.refreshGeneration) {
      return;
    }

    const next = new Map<string, DesktopApproval>();
    for (const approval of approvals) {
      if (approval.id && approval.status === "pending") {
        next.set(approval.id, approval);
      }
    }
    this.approvalById.clear();
    for (const [id, approval] of next) {
      this.approvalById.set(id, approval);
    }
  }

  public async applyEvent(event: DesktopApprovalEvent): Promise<boolean> {
    if (this.disposed
      || (event.type !== "approval.required" && event.type !== "approval.resolved")
      || !event.eventId
      || this.seenEvents.has(event.eventId)) {
      return false;
    }

    this.seenEvents.add(event.eventId);
    while (this.seenEvents.size > maxSeenEvents) {
      const oldest = this.seenEvents.values().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.seenEvents.delete(oldest);
    }
    await this.refresh();
    return true;
  }

  public approveOnce(approvalId: string): Promise<void> {
    return this.decide(approvalId, "approve", "once");
  }

  public deny(approvalId: string): Promise<void> {
    return this.decide(approvalId, "deny", "once");
  }

  public dispose(): void {
    this.disposed = true;
    this.refreshGeneration++;
    this.approvalById.clear();
    this.seenEvents.clear();
  }

  private async decide(
    approvalId: string,
    decision: "approve" | "deny",
    scope: "once" | "taskSession"
  ): Promise<void> {
    if (this.disposed || this.approvalById.get(approvalId)?.status !== "pending") {
      throw new Error("Approval is no longer pending.");
    }

    const operationKey = approvalDecisionKey(approvalId, decision, scope);
    const resolved = await this.backend.decideApproval({
      approvalId,
      decision,
      scope,
      clientRequestId: operationKey,
      idempotencyKey: operationKey
    });
    if (this.disposed) {
      return;
    }

    if (resolved.status === "pending") {
      this.approvalById.set(approvalId, resolved);
    } else {
      this.approvalById.delete(approvalId);
    }
  }
}
