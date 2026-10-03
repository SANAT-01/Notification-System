import { redis } from "./redisClient.js";
import { config } from "./config.js";

// Runtime replacement for editing docker-compose.yml + recreating the workers:
// workers read these per message, so a toggle applies to the next delivery.
export const FLAGS_KEY = "lab:flags";

const envFlags = () => ({
  idempotency: config.IDEMPOTENCY_ENABLED,
  claimLease: config.CLAIM_LEASE_ENABLED,
});

/** Seeds Redis from the env defaults without overwriting a value set from the UI. */
export async function seedFlags() {
  const defaults = envFlags();
  await redis.hsetnx(FLAGS_KEY, "idempotency", String(defaults.idempotency));
  await redis.hsetnx(FLAGS_KEY, "claimLease", String(defaults.claimLease));
}

export async function readFlags() {
  const defaults = envFlags();
  try {
    const stored = await redis.hgetall(FLAGS_KEY);
    return {
      idempotency: stored.idempotency ? stored.idempotency === "true" : defaults.idempotency,
      claimLease: stored.claimLease ? stored.claimLease === "true" : defaults.claimLease,
    };
  } catch {
    return defaults;
  }
}

export async function writeFlags({ idempotency, claimLease }) {
  await redis.hset(FLAGS_KEY, { idempotency: String(idempotency), claimLease: String(claimLease) });
}
