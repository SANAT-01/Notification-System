import { config } from "../config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class InvalidTokenError extends Error {}

/** Simulated provider call. User 999's push token is permanently invalid. */
export async function providerSend(msg) {
  if (config.CHANNEL === "push" && Number(msg.user) === 999) {
    throw new InvalidTokenError("device token rejected by provider");
  }
  await sleep(config.SEND_MS);
}
