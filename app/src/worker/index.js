/**
 * channel worker — consumes one channel's notification queue and "sends" it.
 * One worker per channel (CHANNEL=push|email), consuming the durable queue
 * notify.<channel> with prefetch=1. See handler.js for the idempotency,
 * crash-simulation, and retry/dead-letter behaviour this lab demonstrates.
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import { connectRabbitMQ } from "../rabbitmq.js";
import { redis } from "../redisClient.js";
import { createBaseApp, notFoundHandler, errorHandler } from "../server.js";
import { registerShutdown } from "../shutdown.js";
import { createHandler } from "./handler.js";
import { emitEvent } from "../labEvents.js";
import { readFlags, seedFlags } from "../labFlags.js";

const QUEUE = `notify.${config.CHANNEL}`;
const DLQ = `${config.CHANNEL}.dlq`;

async function main() {
  const connection = await connectRabbitMQ();
  const channel = await connection.createChannel();
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.prefetch(1);

  let rabbitHealthy = true;
  connection.on("close", () => {
    rabbitHealthy = false;
  });
  connection.on("error", () => {
    rabbitHealthy = false;
  });

  await seedFlags();
  const handleMessage = createHandler({ channel, redis, logger, dlq: DLQ });

  await channel.consume(
    QUEUE,
    (rawMsg) => {
      if (rawMsg === null) return; // consumer cancelled by the broker
      handleMessage(rawMsg).catch((err) => {
        logger.error({ err }, "unhandled error processing message — dropping, not requeuing");
        channel.nack(rawMsg, false, false);
      });
    },
    { noAck: false },
  );

  const flags = await readFlags();
  const onOff = (v) => (v ? "ON" : "OFF");
  await emitEvent({
    type: "WORKER_READY",
    channel: config.CHANNEL,
    flags,
    message: `${process.env.SERVICE_NAME || "worker"} ready on ${QUEUE} (idempotency ${onOff(flags.idempotency)}, claim-lease ${onOff(flags.claimLease)})`,
  });

  const app = createBaseApp({
    readiness: () => rabbitHealthy && redis.status === "ready",
  });
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "worker health server listening");
  });

  registerShutdown({ server, channel, connection, redis });
}

main().catch((err) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
