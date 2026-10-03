import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME || "app", channel: config.CHANNEL },
});
