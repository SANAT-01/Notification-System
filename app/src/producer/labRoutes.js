/**
 * Lab-control API (mounted at /lab): everything the dashboard needs to walk
 * through the lab without a terminal — worker events (instead of
 * `docker compose logs | grep`), runtime flags (instead of editing
 * docker-compose.yml + recreating), queue depths (instead of
 * `rabbitmqctl list_queues`), Redis idempotency keys, and DLQ inspection.
 */
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { redis } from "../redisClient.js";
import { EVENTS_STREAM } from "../labEvents.js";
import { readFlags, writeFlags } from "../labFlags.js";

const QUEUE_NAMES = ["notify.push", "notify.email", "push.dlq", "email.dlq"];
const KEY_PATTERN = "notification:*";
const MGMT_AUTH = "Basic " + Buffer.from(`${config.RABBITMQ_USER}:${config.RABBITMQ_PASS}`).toString("base64");

const flagsSchema = z.object({ idempotency: z.boolean(), claimLease: z.boolean() });
const channelSchema = z.enum(["push", "email"]);

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function upstreamError(message) {
  return Object.assign(new Error(message), { status: 502, publicMessage: "rabbitmq_mgmt_unavailable" });
}

async function mgmt(path, init = {}) {
  let res;
  try {
    res = await fetch(`${config.RABBITMQ_MGMT_URL}/api${path}`, {
      ...init,
      headers: { Authorization: MGMT_AUTH, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    throw upstreamError(`rabbitmq mgmt request failed: ${err.message}`);
  }
  if (!res.ok) throw upstreamError(`rabbitmq mgmt returned ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function scanKeys(pattern, max) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0" && keys.length < max);
  return keys.slice(0, max);
}

async function workerUp(url) {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

const parsePayload = (payload) => {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
};

export function createLabRouter() {
  const router = Router();

  router.get(
    "/events",
    wrap(async (req, res) => {
      const since = typeof req.query.since === "string" && /^\d+-\d+$/.test(req.query.since) ? req.query.since : null;
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const raw = since
        ? await redis.xrange(EVENTS_STREAM, `(${since}`, "+", "COUNT", limit)
        : (await redis.xrevrange(EVENTS_STREAM, "+", "-", "COUNT", limit)).reverse();
      const events = raw.map(([id, fields]) => ({ id, ...JSON.parse(fields[1]) }));
      res.json({ events, cursor: events.length ? events[events.length - 1].id : since });
    }),
  );

  router.get(
    "/flags",
    wrap(async (_req, res) => {
      res.json({ flags: await readFlags() });
    }),
  );

  router.put(
    "/flags",
    wrap(async (req, res) => {
      const parsed = flagsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_flags", details: parsed.error.flatten() });
      }
      await writeFlags(parsed.data);
      res.json({ flags: await readFlags() });
    }),
  );

  router.get(
    "/keys",
    wrap(async (_req, res) => {
      const keys = (await scanKeys(KEY_PATTERN, 200)).sort().reverse().slice(0, 50);
      const pipeline = redis.pipeline();
      for (const key of keys) {
        pipeline.get(key);
        pipeline.ttl(key);
      }
      const results = keys.length ? await pipeline.exec() : [];
      res.json({
        keys: keys.map((key, i) => ({ key, value: results[2 * i][1], ttl: results[2 * i + 1][1] })),
      });
    }),
  );

  router.get(
    "/queues",
    wrap(async (_req, res) => {
      const all = await mgmt("/queues/%2F");
      res.json({
        queues: QUEUE_NAMES.map((name) => {
          const q = all.find((item) => item.name === name);
          return {
            name,
            ready: q?.messages_ready ?? 0,
            unacked: q?.messages_unacknowledged ?? 0,
            consumers: q?.consumers ?? 0,
            exists: Boolean(q),
          };
        }),
      });
    }),
  );

  router.get(
    "/dlq/:channel",
    wrap(async (req, res) => {
      const channel = channelSchema.safeParse(req.params.channel);
      if (!channel.success) return res.status(400).json({ error: "invalid_channel" });
      const queue = `${channel.data}.dlq`;
      // ack_requeue_true: peek without consuming — messages stay parked.
      const messages = await mgmt(`/queues/%2F/${encodeURIComponent(queue)}/get`, {
        method: "POST",
        body: JSON.stringify({ count: 20, ackmode: "ack_requeue_true", encoding: "auto" }),
      });
      res.json({ queue, messages: messages.map((m) => ({ payload: parsePayload(m.payload) })) });
    }),
  );

  router.delete(
    "/dlq/:channel",
    wrap(async (req, res) => {
      const channel = channelSchema.safeParse(req.params.channel);
      if (!channel.success) return res.status(400).json({ error: "invalid_channel" });
      await mgmt(`/queues/%2F/${encodeURIComponent(`${channel.data}.dlq`)}/contents`, { method: "DELETE" });
      res.json({ purged: true });
    }),
  );

  router.get(
    "/workers",
    wrap(async (_req, res) => {
      const [push, email] = await Promise.all([workerUp(config.PUSH_WORKER_URL), workerUp(config.EMAIL_WORKER_URL)]);
      res.json({
        workers: [
          { name: "push-worker", up: push },
          { name: "email-worker", up: email },
        ],
      });
    }),
  );

  router.post(
    "/reset",
    wrap(async (_req, res) => {
      await writeFlags({ idempotency: false, claimLease: false });
      const keys = await scanKeys(KEY_PATTERN, 10_000);
      if (keys.length) await redis.del(...keys);
      await redis.del(EVENTS_STREAM);
      await Promise.all(
        QUEUE_NAMES.map((q) =>
          mgmt(`/queues/%2F/${encodeURIComponent(q)}/contents`, { method: "DELETE" }).catch(() => null),
        ),
      );
      res.json({ reset: true, flags: await readFlags() });
    }),
  );

  return router;
}
