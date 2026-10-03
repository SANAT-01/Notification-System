export type Mode = "default" | "crash" | "crash-claim" | "bad-token";

export type EventType =
  | "QUEUED"
  | "RECEIVED"
  | "SENT"
  | "CRASH"
  | "DUPLICATE_DROPPED"
  | "CLAIM_RECOVERED"
  | "RETRY"
  | "DEAD_LETTER"
  | "WORKER_READY";

export type Flags = { idempotency: boolean; claimLease: boolean };

export type LabEvent = {
  id: string;
  type: EventType;
  service: string;
  message: string;
  ts: number;
  channel?: string;
  notifId?: number;
  user?: number;
  redelivered?: boolean;
  phase?: string;
  attempt?: number;
  flags?: Flags;
};

export type QueueStat = { name: string; ready: number; unacked: number; consumers: number; exists: boolean };
export type KeyEntry = { key: string; value: string | null; ttl: number };
export type WorkerStatus = { name: string; up: boolean };

export type StepRun = { notifId: number; firedAt: number; flagsAtFire: Flags | null };
