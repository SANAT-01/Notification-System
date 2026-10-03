import amqp from "amqplib";
import { config } from "./config.js";
import { logger } from "./logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects with a retry loop — RabbitMQ takes a while to boot, same as the
 * original worker.py's "while True: try connect except: sleep(2)".
 */
export async function connectRabbitMQ() {
  const url = `amqp://${config.RABBITMQ_USER}:${config.RABBITMQ_PASS}@${config.RABBITMQ_HOST}`;
  for (;;) {
    try {
      const connection = await amqp.connect(url, { heartbeat: 30 });
      logger.info("connected to rabbitmq");
      return connection;
    } catch (err) {
      logger.warn({ err: err.message }, "waiting for rabbitmq");
      await sleep(2000);
    }
  }
}
