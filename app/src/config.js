import { z } from "zod";

const boolFromEnv = (defaultValue) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v.toLowerCase() === "true"));

const schema = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),

  RABBITMQ_HOST: z.string().default("rabbitmq"),
  RABBITMQ_USER: z.string().default("guest"),
  RABBITMQ_PASS: z.string().default("guest"),

  RABBITMQ_MGMT_URL: z.string().url().default("http://rabbitmq:15672"),

  // producer-only: where the lab API checks worker health
  PUSH_WORKER_URL: z.string().url().default("http://push-worker:3000"),
  EMAIL_WORKER_URL: z.string().url().default("http://email-worker:3000"),

  REDISHOST: z.string().default("redis"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),

  // worker-only
  CHANNEL: z.enum(["push", "email"]).default("push"),
  IDEMPOTENCY_ENABLED: boolFromEnv(false),
  CLAIM_LEASE_ENABLED: boolFromEnv(false),
  SEND_MS: z.coerce.number().int().nonnegative().default(200),
});

function loadConfig() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
