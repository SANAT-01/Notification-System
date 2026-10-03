import { logger } from "./logger.js";

/**
 * Registers SIGTERM/SIGINT handlers that drain in order: stop accepting new
 * HTTP requests, close the AMQP channel/connection, close Redis, then exit.
 * Each resource is optional so producer and worker can share this helper.
 */
export function registerShutdown({ server, channel, connection, redis }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    for (const [label, closer] of [
      ["amqp channel", () => channel?.close()],
      ["amqp connection", () => connection?.close()],
      ["redis", () => redis?.quit()],
    ]) {
      try {
        await closer();
      } catch (err) {
        logger.warn({ err: err.message, resource: label }, "error while closing resource");
      }
    }

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
