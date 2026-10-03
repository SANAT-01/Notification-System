/**
 * producer — HTTP front door for the lab. POST /notify publishes one
 * notification event, fanned out to one durable queue per channel
 * (notify.push, notify.email) so a slow or dead channel never blocks the
 * others. This process never talks to the workers directly.
 *
 * Modes (mirrors the old publish.py flags):
 *   default      -> user 7, published to notify.push AND notify.email
 *   crash        -> user 7, push only, crash_after_send=true (worker dies
 *                   after sending, before acking — the duplicate demo)
 *   crash-claim  -> user 7, push only, crash_claim=true (worker dies right
 *                   after claiming the idempotency record, before ever
 *                   calling the provider — the "claim but never sent" demo)
 *   bad-token    -> user 999, push only (provider always rejects user 999's
 *                   device token — the retry + dead-letter demo)
 */
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { connectRabbitMQ } from "../rabbitmq.js";
import { createBaseApp, notFoundHandler, errorHandler } from "../server.js";
import { registerShutdown } from "../shutdown.js";
import { publishedTotal } from "../metrics.js";
import rateLimit from "express-rate-limit";
import { emitEvent } from "../labEvents.js";
import { redis } from "../redisClient.js";
import { createLabRouter } from "./labRoutes.js";

const QUEUES = { push: "notify.push", email: "notify.email" };

const notifyRequestSchema = z.object({
  mode: z.enum(["default", "crash", "crash-claim", "bad-token"]).default("default"),
});

function buildNotification(mode) {
  const crash = mode === "crash";
  const crashClaim = mode === "crash-claim";
  const badToken = mode === "bad-token";

  const id = Math.floor(Date.now() / 1000);
  const user = badToken ? 999 : 7;
  const queues = crash || crashClaim || badToken ? [QUEUES.push] : [QUEUES.push, QUEUES.email];

  const message = {
    id,
    user,
    text: "Your order has shipped!",
    crash_after_send: crash,
    crash_claim: crashClaim,
  };

  return { message, queues };
}

async function main() {
  const connection = await connectRabbitMQ();
  const channel = await connection.createConfirmChannel();
  for (const queue of Object.values(QUEUES)) {
    await channel.assertQueue(queue, { durable: true });
  }

  let rabbitHealthy = true;
  connection.on("close", () => {
    rabbitHealthy = false;
  });
  connection.on("error", () => {
    rabbitHealthy = false;
  });

  const app = createBaseApp({ readiness: () => rabbitHealthy });

  const notifyLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true });

  app.post("/notify", notifyLimiter, async (req, res, next) => {
    const parsed = notifyRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    try {
      const { message, queues } = buildNotification(parsed.data.mode);
      const body = Buffer.from(JSON.stringify(message));

      for (const queue of queues) {
        channel.publish("", queue, body, { persistent: true });
        publishedTotal.inc({ queue });
      }

      await emitEvent({
        type: "QUEUED",
        notifId: message.id,
        user: message.user,
        queues,
        mode: parsed.data.mode,
        message: `queued notif:${message.id} for user:${message.user} -> ${queues.join(", ")}`,
      });
      res.status(202).json({ queued: true, id: message.id, user: message.user, queues, mode: parsed.data.mode });
    } catch (err) {
      next(err);
    }
  });

  app.use("/lab", createLabRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "producer listening");
  });

  registerShutdown({ server, channel, connection, redis });
}

main().catch((err) => {
  logger.error({ err }, "producer failed to start");
  process.exit(1);
});
