// apps/backend/src/queue/controlTypes.ts
//
// Serializable control-plane messages sent from the API to a worker that owns
// a distributed mission. These mirror the existing ORVYN controls rather than
// inventing a second permission model.

export type ApprovalScope = "once" | "mission";

export type RunControlCommand =
  | {
      id: string;
      type: "cancel";
      runId: string;
      tenantId: string;
      requestedAt: number;
    }
  | {
      id: string;
      type: "steer";
      runId: string;
      tenantId: string;
      text: string;
      requestedAt: number;
    }
  | {
      id: string;
      type: "approval";
      runId: string;
      tenantId: string;
      callId: string;
      approved: boolean;
      scope: ApprovalScope;
      requestedAt: number;
    };
