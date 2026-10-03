import { config } from "../config.js";
import { providerSend, InvalidTokenError } from "./providerSend.js";
import { notificationsTotal, retriesTotal } from "../metrics.js";
import { emitEvent } from "../labEvents.js";
import { readFlags } from "../labFlags.js";

const MAX_ATTEMPTS = 3;
const CLAIM_LEASE_SECONDS = 10;
const DONE_TTL_SECONDS = 86400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-message handler for one channel worker: claim (if enabled) -> crash-claim
 * hook -> send with retry/DLQ -> confirm claim -> crash-after-send hook -> ack.
 */
export function createHandler({ channel, redis, logger, dlq }) {
  const ch = config.CHANNEL;

  return async function handleMessage(rawMsg) {
    const msg = JSON.parse(rawMsg.content.toString());
    const key = `notification:${msg.id}:${ch}:${msg.user}`;
    const redelivered = rawMsg.fields.redelivered;
    const ids = { notifId: msg.id, user: msg.user, channel: ch };
    const flags = await readFlags();
    const ack = () => channel.ack(rawMsg);

    await emitEvent({
      type: "RECEIVED",
      ...ids,
      redelivered,
      flags,
      message: `RECEIVED ${ch} notif:${msg.id}${redelivered ? " (redelivered)" : ""}`,
    });

    const dropDuplicate = async () => {
      notificationsTotal.inc({ channel: ch, outcome: "duplicate_dropped" });
      await emitEvent({
        type: "DUPLICATE_DROPPED",
        ...ids,
        message: `DUPLICATE DROPPED notif:${msg.id} (${ch} already delivered to user:${msg.user})`,
      });
      ack();
    };

    if (flags.idempotency && !flags.claimLease) {
      // Single permanent claim: fixes crash-after-send, but can't tell
      // "in progress" apart from "done".
      let claimed = "OK";
      try {
        claimed = await redis.set(key, "1", "EX", DONE_TTL_SECONDS, "NX");
      } catch (err) {
        logger.warn({ err: err.message }, "redis unavailable, sending without dedupe");
      }
      if (claimed === null) return dropDuplicate();
    }

    if (flags.idempotency && flags.claimLease) {
      // Two-state claim: short pending lease before the send, upgraded to done
      // only after it succeeds — closes the crash-claim gap.
      try {
        const state = await redis.get(key);
        if (state === "done") return dropDuplicate();
        if (state === "pending") {
          notificationsTotal.inc({ channel: ch, outcome: "claim_recovered" });
          await emitEvent({
            type: "CLAIM_RECOVERED",
            ...ids,
            message: `CLAIM RECOVERED notif:${msg.id} (previous attempt claimed it but never sent) — retrying`,
          });
        }
        await redis.set(key, "pending", "EX", CLAIM_LEASE_SECONDS);
      } catch (err) {
        logger.warn({ err: err.message }, "redis unavailable, sending without dedupe");
      }
    }

    if (msg.crash_claim && !redelivered) {
      await emitEvent({
        type: "CRASH",
        level: "warn",
        phase: "after_claim",
        ...ids,
        message: `CRASH — worker dying AFTER claim, BEFORE send (notif:${msg.id})`,
      });
      process.exit(1);
    }

    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await providerSend(msg);
        notificationsTotal.inc({ channel: ch, outcome: "sent" });
        await emitEvent({
          type: "SENT",
          ...ids,
          message: `SENT ${ch} notif:${msg.id} -> user:${msg.user} "${msg.text}"`,
        });
        break;
      } catch (err) {
        if (!(err instanceof InvalidTokenError)) throw err;

        if (attempts >= MAX_ATTEMPTS) {
          channel.publish("", dlq, rawMsg.content, { persistent: true });
          notificationsTotal.inc({ channel: ch, outcome: "dead_lettered" });
          await emitEvent({
            type: "DEAD_LETTER",
            level: "warn",
            attempt: attempts,
            ...ids,
            message: `DEAD-LETTER notif:${msg.id} -> ${dlq} after ${attempts} attempts (${err.message})`,
          });
          return ack();
        }

        const backoffSeconds = 0.5 * 2 ** (attempts - 1);
        retriesTotal.inc({ channel: ch });
        await emitEvent({
          type: "RETRY",
          attempt: attempts,
          backoffSeconds,
          ...ids,
          message: `RETRY ${attempts}/${MAX_ATTEMPTS} notif:${msg.id} (${err.message}) — backing off ${backoffSeconds}s`,
        });
        await sleep(backoffSeconds * 1000);
      }
    }

    if (flags.idempotency && flags.claimLease) {
      try {
        await redis.set(key, "done", "EX", DONE_TTL_SECONDS);
      } catch (err) {
        logger.warn({ err: err.message }, "redis unavailable, could not confirm claim");
      }
    }

    if (msg.crash_after_send && !redelivered) {
      // Sent, but the ack never happens: RabbitMQ will redeliver this message.
      await emitEvent({
        type: "CRASH",
        level: "warn",
        phase: "after_send",
        ...ids,
        message: `CRASH — worker dying after send, BEFORE ack (notif:${msg.id})`,
      });
      process.exit(1);
    }

    ack();
  };
}
