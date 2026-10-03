import type { EventType, Flags, LabEvent, Mode } from "./types";

export type Verdict = { kind: "ok" | "bug" | "fixed"; title: string; detail: string };

export type StepDef = {
  id: string;
  number: number;
  title: string;
  mode: Mode;
  flags: Flags | null;
  concept: string;
  action: string;
  expect: string;
  grep: string;
  timeoutMs: number;
  cli: string[];
  takeaway: string;
  evaluate: (events: LabEvent[]) => Verdict | null;
};

const count = (events: LabEvent[], type: EventType, channel?: string) =>
  events.filter((e) => e.type === type && (!channel || e.channel === channel)).length;

const notify = (mode: Mode) =>
  `curl -s -X POST localhost:3100/api/notify -H 'Content-Type: application/json' -d '{"mode":"${mode}"}'`;

const setFlags = (f: Flags) =>
  `curl -s -X PUT localhost:3100/api/lab/flags -H 'Content-Type: application/json' -d '{"idempotency":${f.idempotency},"claimLease":${f.claimLease}}'`;

export const STEPS: StepDef[] = [
  {
    id: "fanout",
    number: 1,
    title: "Fan-out: one event, two channels",
    mode: "default",
    flags: null,
    concept:
      "The producer publishes one event, but writes one durable message per channel queue — notify.push and notify.email. Each channel has its own worker, so a slow or dead channel never blocks the others. The producer never talks to the workers; the broker decouples them.",
    action: "Fire one normal notification for user 7.",
    expect:
      "SENT push notif:<id> -> user:7 from push-worker and SENT email notif:<id> -> user:7 from email-worker — the same notification id on both.",
    grep: "SENT",
    timeoutMs: 6000,
    cli: [notify("default"), "docker compose logs push-worker email-worker | grep SENT"],
    takeaway: "Queue-per-channel isolates failures: one event, two queues, two independent consumers.",
    evaluate: (ev) =>
      count(ev, "SENT", "push") >= 1 && count(ev, "SENT", "email") >= 1
        ? {
            kind: "ok",
            title: "Delivered on both channels",
            detail: "One event fanned out to two queues and was consumed by two independent workers.",
          }
        : null,
  },
  {
    id: "duplicate",
    number: 2,
    title: "The fail moment: crash between send and ack",
    mode: "crash",
    flags: { idempotency: false, claimLease: false },
    concept:
      "RabbitMQ only forgets a message once the consumer acks it — that's at-least-once delivery. The push worker has a crash hook: it sends the notification, then dies before acking. Docker restarts it (restart: unless-stopped) and the broker redelivers the un-acked message to the fresh worker.",
    action: "Fire a notification that makes push-worker crash after sending, before acking.",
    expect:
      "SENT push notif:<id>, then CRASH — worker dying after send, BEFORE ack, then after the restart the same notif id is SENT again.",
    grep: "SENT|CRASH|RECEIVED|ready",
    timeoutMs: 10000,
    cli: [setFlags({ idempotency: false, claimLease: false }), notify("crash"), "docker compose logs push-worker | grep -E 'SENT|CRASH'"],
    takeaway:
      "At-least-once delivery + a crash in the send→ack window = duplicates. The broker did its job; the consumer must make redelivery safe.",
    evaluate: (ev) => {
      const sent = count(ev, "SENT", "push");
      return count(ev, "CRASH") >= 1 && sent >= 2
        ? {
            kind: "bug",
            title: "Duplicate reproduced",
            detail: `The user was notified ${sent}× for one event. The message was never acked, so RabbitMQ redelivered it.`,
          }
        : null;
    },
  },
  {
    id: "idempotency",
    number: 3,
    title: "The fix: an idempotency record",
    mode: "crash",
    flags: { idempotency: true, claimLease: false },
    concept:
      "Before sending, the worker claims a Redis record notification:<id>:<channel>:<user> with SET NX EX 86400 (only succeeds if the key doesn't exist, expires in 24h). The crash and redelivery still happen, but the redelivery finds the record already claimed and skips the send.",
    action: "Turn on IDEMPOTENCY_ENABLED, then trigger the same crash again.",
    expect:
      "SENT push notif:<id>, CRASH — worker dying after send, BEFORE ack, then DUPLICATE DROPPED instead of a second SENT. Watch the key appear in the Redis panel.",
    grep: "SENT|CRASH|DUPLICATE",
    timeoutMs: 10000,
    cli: [setFlags({ idempotency: true, claimLease: false }), notify("crash"), "docker compose logs push-worker | grep -E 'SENT|CRASH|DUPLICATE'"],
    takeaway: "You can't make delivery exactly-once, but you can make processing idempotent: dedupe on a stable key with a TTL.",
    evaluate: (ev) =>
      count(ev, "CRASH") >= 1 && count(ev, "DUPLICATE_DROPPED") >= 1 && count(ev, "SENT", "push") === 1
        ? {
            kind: "fixed",
            title: "One buzz, not two",
            detail: "The redelivery found the claim in Redis and dropped itself without resending.",
          }
        : null,
  },
  {
    id: "gap",
    number: 4,
    title: "A gap in the fix: crash before the send",
    mode: "crash-claim",
    flags: { idempotency: true, claimLease: false },
    concept:
      "The claim is written before the provider is ever called, and it's one permanent fact — it can't tell \"I'm working on this\" apart from \"I finished this.\" If the worker dies in that exact gap, the claim is already sitting in Redis when the message is redelivered.",
    action: "Keep idempotency on (claim-lease off) and crash the worker right after it claims, before it sends.",
    expect:
      "CRASH — worker dying AFTER claim, BEFORE send, then DUPLICATE DROPPED — and no SENT line anywhere for this notif id.",
    grep: "",
    timeoutMs: 10000,
    cli: [setFlags({ idempotency: true, claimLease: false }), notify("crash-claim"), "docker compose logs push-worker | tail -6"],
    takeaway: "A dedupe marker written before the side effect turns a duplicate bug into a silent-loss bug — which is worse.",
    evaluate: (ev) =>
      count(ev, "CRASH") >= 1 && count(ev, "DUPLICATE_DROPPED") >= 1 && count(ev, "SENT") === 0
        ? {
            kind: "bug",
            title: "Notification lost silently",
            detail: "Redelivery saw the claim, treated it as a duplicate and dropped it — but nothing was ever sent. No error anywhere.",
          }
        : null,
  },
  {
    id: "lease",
    number: 5,
    title: "Closing the gap: a claim that knows the difference",
    mode: "crash-claim",
    flags: { idempotency: true, claimLease: true },
    concept:
      "Split the claim into two states: a short-lived pending lease (10s TTL) written before the send, upgraded to a long-lived done marker (24h) only after the send succeeds. On redelivery, done means a real duplicate (drop); pending means the previous attempt never finished (retry).",
    action: "Turn on CLAIM_LEASE_ENABLED and trigger the same crash-after-claim.",
    expect:
      "CRASH after claim, then CLAIM RECOVERED on redelivery, then SENT push notif:<id> — exactly once. The Redis key goes pending → done.",
    grep: "",
    timeoutMs: 10000,
    cli: [setFlags({ idempotency: true, claimLease: true }), notify("crash-claim"), "docker compose logs push-worker | tail -6"],
    takeaway: "Separate \"claimed\" from \"completed\". A lease that expires means a crashed owner can never block the work forever.",
    evaluate: (ev) =>
      count(ev, "CRASH") >= 1 && count(ev, "CLAIM_RECOVERED") >= 1 && count(ev, "SENT", "push") === 1
        ? {
            kind: "fixed",
            title: "Recovered — sent exactly once",
            detail: "The redelivery found a pending lease, recognised an unfinished attempt and retried the send.",
          }
        : null,
  },
  {
    id: "dlq",
    number: 6,
    title: "Retries, backoff, and the dead-letter queue",
    mode: "bad-token",
    flags: null,
    concept:
      "User 999's device token is permanently invalid — the provider rejects it every time. The worker retries with exponential backoff (0.5s, then 1s), and after the 3rd failed attempt publishes the message to push.dlq and acks the original. A poison message gets parked for inspection, it doesn't block the queue or retry forever.",
    action: "Send a notification to user 999.",
    expect:
      "RETRY 1/3 (0.5s backoff), RETRY 2/3 (1s backoff), then DEAD-LETTER notif:<id> -> push.dlq. The push.dlq count goes up — inspect it in the DLQ panel.",
    grep: "RETRY|DEAD-LETTER",
    timeoutMs: 9000,
    cli: [notify("bad-token"), "docker compose logs push-worker | grep -E 'RETRY|DEAD-LETTER'", "docker exec rabbitmq rabbitmqctl list_queues name messages"],
    takeaway: "Bound your retries. Transient failures get backoff; permanent ones get a DLQ so one bad message can't stall everyone else.",
    evaluate: (ev) =>
      count(ev, "RETRY") >= 2 && count(ev, "DEAD_LETTER") >= 1
        ? {
            kind: "ok",
            title: "Parked in push.dlq",
            detail: "3 attempts, exponential backoff, then dead-lettered. notify.push kept flowing.",
          }
        : null,
  },
];
