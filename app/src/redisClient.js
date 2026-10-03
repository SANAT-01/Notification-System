import Redis from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

export const redis = new Redis({
  host: config.REDISHOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});

redis.on("error", (err) => {
  logger.warn({ err: err.message }, "redis connection error");
});
