#!/usr/bin/env python3
"""producer — publishes one notification event to the per-channel queues.

Driven by ./notify.sh. One EVENT ("order shipped") becomes one message on EACH
channel queue — queue per channel, so a slow or dead channel never blocks the
others. The producer drops the messages and returns immediately; it never talks
to the workers.

Modes:
  (default)     -> user 7, published to notify.push AND notify.email
  --crash       -> user 7, push only, with crash_after_send=true (the worker will
                   die after sending, before acking — the duplicate demo)
  --crash-claim -> user 7, push only, with crash_claim=true (the worker will die
                   right after claiming the idempotency record, before ever
                   calling the provider — the "claim but never sent" demo)
  --bad-token   -> user 999, push only (provider always rejects 999's device token
                   — the retry + dead-letter demo)
"""
import json
import os
import sys
import time

import pika

HOST = os.environ.get("RABBITMQ_HOST", "rabbitmq")
USER = os.environ.get("RABBITMQ_USER", "guest")
PASS = os.environ.get("RABBITMQ_PASS", "guest")


def main():
    crash = "--crash" in sys.argv
    crash_claim = "--crash-claim" in sys.argv
    bad_token = "--bad-token" in sys.argv
    notif_id = int(time.time())
    user = 999 if bad_token else 7
    queues = ["notify.push"] if (crash or crash_claim or bad_token) else ["notify.push", "notify.email"]

    msg = {
        "id": notif_id,
        "user": user,
        "text": "Your order has shipped!",
        "crash_after_send": crash,
        "crash_claim": crash_claim,
    }

    params = pika.ConnectionParameters(
        host=HOST,
        credentials=pika.PlainCredentials(USER, PASS),
        connection_attempts=5,
        retry_delay=2,
        socket_timeout=5,
    )
    conn = pika.BlockingConnection(params)
    ch = conn.channel()
    for q in queues:
        ch.queue_declare(queue=q, durable=True)
        ch.basic_publish(
            exchange="",
            routing_key=q,
            body=json.dumps(msg).encode(),
            properties=pika.BasicProperties(delivery_mode=2),  # persistent
        )
    conn.close()
    tag = (" (crash-after-send)" if crash
           else " (crash-claim)" if crash_claim
           else " (bad token)" if bad_token
           else "")
    print("queued notif:%d for user:%d -> %s%s" % (
        notif_id, user, ", ".join(queues), tag,
    ), flush=True)


if __name__ == "__main__":
    main()
