#!/usr/bin/env python3
"""channel worker — consumes one channel's notification queue and "sends" them.

One worker per channel (CHANNEL=push|email), consuming the durable queue
notify.<channel>. For each message it simulates the provider call (200ms), logs
`SENT <channel> notif:<id> -> user:<uid>`, and only THEN acks.

The three failure behaviours this lab demonstrates:

  * crash-after-send: if the message carries crash_after_send=true and this is its
    FIRST delivery, the worker logs a CRASH line and kills itself after sending but
    BEFORE acking. Docker restarts the worker, RabbitMQ redelivers the un-acked
    message, and the user gets the notification TWICE — the deterministic
    at-least-once duplicate.

  * idempotency (the fix): with IDEMPOTENCY_ENABLED=true the worker claims a Redis
    record `notification:<id>:<channel>:<user>` (SET NX, 24h TTL) before sending.
    A redelivery finds the record already claimed, logs `DUPLICATE DROPPED`, and
    acks without sending. This closes the crash-after-send gap above — but it has
    its own gap, below.

  * crash-claim: if the message carries crash_claim=true and this is its FIRST
    delivery, the worker claims the notification and dies immediately, BEFORE
    ever calling the provider. The claim above is a single, permanent fact
    written the moment it's made — it can't tell "I'm working on this" apart
    from "I finished this." So the redelivery finds the same claim, treats it
    as a real duplicate, and drops it — the notification is silently LOST, not
    duplicated. No error anywhere.

  * the second fix — CLAIM_LEASE_ENABLED=true splits that one permanent claim
    into two states instead of one:
        pending -> claimed, send not yet confirmed (short lease, a few seconds)
        done    -> the send actually completed (24h TTL, a real duplicate now)
    A redelivery that finds `done` still drops as a duplicate. One that finds
    `pending` (the previous attempt crashed before finishing) logs
    `CLAIM RECOVERED` and retries instead of silently losing it.

  * retry + dead-letter: user 999's device token is permanently invalid, so the
    provider call raises. The worker retries 3 times with exponential backoff
    (0.5s, 1s, 2s), then publishes the message to <channel>.dlq and acks — poison
    messages get parked for replay, they don't block the queue forever.

Standard library + pika (vendored wheel) only.
"""
import json
import os
import socket
import sys
import time

import pika

CHANNEL = os.environ.get("CHANNEL", "push")
QUEUE = "notify.%s" % CHANNEL
DLQ = "%s.dlq" % CHANNEL
HOST = os.environ.get("RABBITMQ_HOST", "rabbitmq")
USER = os.environ.get("RABBITMQ_USER", "guest")
PASS = os.environ.get("RABBITMQ_PASS", "guest")
REDISHOST = os.environ.get("REDISHOST", "redis")
IDEMPOTENCY_ENABLED = os.environ.get("IDEMPOTENCY_ENABLED", "false").lower() == "true"
CLAIM_LEASE_ENABLED = os.environ.get("CLAIM_LEASE_ENABLED", "false").lower() == "true"
SEND_MS = int(os.environ.get("SEND_MS", "200"))
MAX_ATTEMPTS = 3
CLAIM_LEASE_SECONDS = 10


# ----------------------------- minimal Redis (RESP) -----------------------------
def _redis(*args):
    with socket.create_connection((REDISHOST, 6379), timeout=3) as s:
        cmd = b"*%d\r\n" % len(args)
        for a in args:
            b = str(a).encode()
            cmd += b"$%d\r\n%s\r\n" % (len(b), b)
        s.sendall(cmd)
        f = s.makefile("rb")
        line = f.readline()
        tag, rest = line[:1], line[1:].strip()
        if tag == b"+":
            return rest.decode()
        if tag == b"-":
            raise RuntimeError(rest.decode())
        if tag == b":":
            return int(rest)
        if tag == b"$":
            n = int(rest)
            if n == -1:
                return None
            data = f.read(n)
            f.read(2)
            return data.decode()
        return None


class InvalidToken(Exception):
    pass


def provider_send(msg):
    """Simulated provider call. User 999's push token is permanently invalid."""
    if CHANNEL == "push" and int(msg["user"]) == 999:
        raise InvalidToken("device token rejected by provider")
    time.sleep(SEND_MS / 1000.0)
    print('SENT %s notif:%s -> user:%s "%s"' % (CHANNEL, msg["id"], msg["user"], msg["text"]), flush=True)


def on_message(ch, method, _props, body):
    msg = json.loads(body.decode())
    key = "notification:%s:%s:%s" % (msg["id"], CHANNEL, msg["user"])

    if IDEMPOTENCY_ENABLED and not CLAIM_LEASE_ENABLED:
        # Original single-marker claim: one permanent fact, written before the
        # send. Fixes crash-after-send, but can't tell "in progress" from "done".
        try:
            claimed = _redis("SET", key, "1", "NX", "EX", 86400)
        except Exception as e:
            print("worker: redis unavailable (%s), sending without dedupe" % e, flush=True)
            claimed = "OK"
        if claimed is None:
            print("DUPLICATE DROPPED notif:%s (%s already delivered to user:%s)"
                  % (msg["id"], CHANNEL, msg["user"]), flush=True)
            ch.basic_ack(delivery_tag=method.delivery_tag)
            return

    if IDEMPOTENCY_ENABLED and CLAIM_LEASE_ENABLED:
        # The second fix: a short-lived pending lease before the send, confirmed
        # to done only after it succeeds — closes the crash-claim gap above.
        try:
            state = _redis("GET", key)
            if state == "done":
                print("DUPLICATE DROPPED notif:%s (%s already delivered to user:%s)"
                      % (msg["id"], CHANNEL, msg["user"]), flush=True)
                ch.basic_ack(delivery_tag=method.delivery_tag)
                return
            if state == "pending":
                print("CLAIM RECOVERED notif:%s (previous attempt claimed it but never sent) — retrying"
                      % msg["id"], flush=True)
            _redis("SET", key, "pending", "EX", CLAIM_LEASE_SECONDS)
        except Exception as e:
            print("worker: redis unavailable (%s), sending without dedupe" % e, flush=True)

    if msg.get("crash_claim") and not method.redelivered:
        # Claimed, but crashes before the provider is ever called: proves the
        # claim only becomes a real duplicate marker once the send is confirmed.
        print("CRASH — worker dying AFTER claim, BEFORE send (notif:%s)" % msg["id"], flush=True)
        os._exit(1)

    attempts = 0
    while True:
        attempts += 1
        try:
            provider_send(msg)
            break
        except InvalidToken as e:
            if attempts >= MAX_ATTEMPTS:
                ch.basic_publish(
                    exchange="",
                    routing_key=DLQ,
                    body=body,
                    properties=pika.BasicProperties(delivery_mode=2),
                )
                print("DEAD-LETTER notif:%s -> %s after %d attempts (%s)"
                      % (msg["id"], DLQ, attempts, e), flush=True)
                ch.basic_ack(delivery_tag=method.delivery_tag)
                return
            backoff = 0.5 * (2 ** (attempts - 1))
            print("RETRY %d/%d notif:%s (%s) — backing off %.1fs"
                  % (attempts, MAX_ATTEMPTS, msg["id"], e, backoff), flush=True)
            time.sleep(backoff)

    if IDEMPOTENCY_ENABLED and CLAIM_LEASE_ENABLED:
        try:
            _redis("SET", key, "done", "EX", 86400)
        except Exception as e:
            print("worker: redis unavailable (%s), could not confirm claim" % e, flush=True)

    if msg.get("crash_after_send") and not method.redelivered:
        # Sent, but the ack never happens: simulate the worker dying at the worst
        # possible moment. RabbitMQ will redeliver this exact message.
        print("CRASH — worker dying after send, BEFORE ack (notif:%s)" % msg["id"], flush=True)
        os._exit(1)

    ch.basic_ack(delivery_tag=method.delivery_tag)


def main():
    params = pika.ConnectionParameters(
        host=HOST,
        credentials=pika.PlainCredentials(USER, PASS),
        heartbeat=30,
        connection_attempts=1,
        socket_timeout=5,
    )
    # RabbitMQ takes a while to boot; keep retrying until it answers.
    while True:
        try:
            conn = pika.BlockingConnection(params)
            break
        except Exception as e:
            print("worker: waiting for rabbitmq (%s)" % e, flush=True)
            time.sleep(2)

    ch = conn.channel()
    ch.queue_declare(queue=QUEUE, durable=True)
    ch.queue_declare(queue=DLQ, durable=True)
    ch.basic_qos(prefetch_count=1)
    ch.basic_consume(queue=QUEUE, on_message_callback=on_message)
    print("worker: ready on %s (idempotency %s, claim-lease %s)"
          % (QUEUE, "ON" if IDEMPOTENCY_ENABLED else "OFF", "ON" if CLAIM_LEASE_ENABLED else "OFF"), flush=True)
    try:
        ch.start_consuming()
    except (KeyboardInterrupt, SystemExit):
        conn.close()
        sys.exit(0)


if __name__ == "__main__":
    while True:
        try:
            main()
        except Exception as e:
            # connection dropped (e.g. broker restart) — reconnect and resume.
            print("worker: connection lost (%s), reconnecting" % e, flush=True)
            time.sleep(2)
