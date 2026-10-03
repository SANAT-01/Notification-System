import { redis } from "./redisClient.js";
import { logger } from "./logger.js";

export const EVENTS_STREAM = "lab:events";
const STREAM_MAX_LEN = 2000;

/**
 * Logs a lab-significant event and appends it to a capped Redis stream so the
 * dashboard can show worker logs without docker socket access. Awaited before
 * the crash hooks exit, so the CRASH line is never lost.
 */
export async function emitEvent({ type, message, level = "info", ...fields }) {
  const service = process.env.SERVICE_NAME || "app";
  logger[level]({ event: type, ...fields }, message);
  const event = { type, service, message, ts: Date.now(), ...fields };
  try {
    await redis.xadd(EVENTS_STREAM, "MAXLEN", "~", STREAM_MAX_LEN, "*", "data", JSON.stringify(event));
  } catch (err) {
    logger.warn({ err: err.message }, "could not record lab event");
  }
}
