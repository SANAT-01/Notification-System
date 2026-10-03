This is the notification system from the video, running for real: a producer publishes one event, queue-per-channel fans it to a push and an email worker, and every delivery is logged. Then you break it the way production breaks: a worker crashes after sending but before acking, RabbitMQ redelivers, and the user gets paged twice. You'll fix it with an idempotency record in Redis, and park a permanently failing notification in a dead-letter queue after retries with backoff are exhausted.

The stack lives in /root/lab3 as a docker-compose project: rabbitmq (management UI on port 15672, login guest/guest), redis, producer, push-worker, and email-worker. Fire events with the helper ./notify.sh.

Learning outcomes:

Fan one event across per-channel queues and read deliveries from worker logs
Reproduce a real duplicate delivery (crash between send and ack)
Fix it with an idempotency key (notification:<id>:<channel>:<recipient>, TTL)
Watch retry + exponential backoff end in a dead-letter queue, not a stuck queue

---

From /root/lab3, bring the whole stack up in the background, then fire one notification event and watch it land on both channels:

cd /root/lab3
docker compose up -d
sleep 10
./notify.sh
sleep 2
docker compose logs push-worker email-worker | grep SENT

One event, two queues, two workers: you should see SENT push notif:<id> -> user:7 from the push worker and SENT email notif:<id> -> user:7 from the email worker—same notification id on both.


You can watch the notify.push and notify.email queues live in the RabbitMQ Management UI: click the RabbitMQ button at the top of the terminal and log in with guest / guest.

---

The fail moment - crash between send and ack. The push worker has a crash hook: it sends the notification, then dies before acknowledging the queue message. Trigger it and watch what RabbitMQ does:

cd /root/lab3
./notify.sh --crash
sleep 8
docker compose logs push-worker | grep -E 'SENT|CRASH'

Read the log carefully: SENT push notif:<id> … CRASH — worker dying after send, BEFORE ack … and then, after Docker restarts the worker, the same notif id is SENT again. The message was never acked, so RabbitMQ redelivered it; the user's phone buzzed twice for one event.

---

The fix - an idempotency record. Both workers have a flag that turns on a dedupe check before sending; right now it's off, which is exactly why the crash produced a duplicate. Turn it on for push-worker and email-worker in /root/lab3/docker-compose.yml, recreate them, and trigger the crash again:

cd /root/lab3
docker compose up -d push-worker email-worker
sleep 3
./notify.sh --crash
sleep 8
docker compose logs push-worker | grep -E 'SENT|CRASH|DUPLICATE'

Before sending, the worker now claims a Redis record: notification:<id>:push:<user> with a 24h TTL. The crash and redelivery still happen, but the redelivery finds the record already claimed and logs DUPLICATE DROPPED instead of sending. One buzz, not two.


---

A gap in the fix - crash before the send. The idempotency claim happens before the provider is ever called. What if the crash lands in that exact gap, before the send happens at all? Trigger it:

cd /root/lab3
./notify.sh --crash-claim
sleep 8
docker compose logs push-worker | tail -6

The worker claims the notification, then dies immediately, before it ever touches the provider. On redelivery, the claim is already sitting in Redis, so the worker treats it exactly like the earlier duplicate case and logs DUPLICATE DROPPED. But this time that's wrong: there is no SENT line anywhere for this notif id. The notification wasn't duplicated; it was lost, silently, with no error.


---


Closing the gap - a claim that knows the difference. The claim needs to tell "in progress" apart from "confirmed done" instead of writing one permanent fact upfront. There's a second flag on both workers that switches the claim to exactly that two-state design; turn it on for push-worker and email-worker in /root/lab3/docker-compose.yml, recreate them, and trigger the same crash again:

cd /root/lab3
docker compose up -d push-worker email-worker
sleep 3
./notify.sh --crash-claim
sleep 8
docker compose logs push-worker | tail -6

The claim is now written as a short-lived pending lease before the send, and only upgraded to a confirmed, long-lived done marker after the send actually succeeds. The crash still happens at the same instant, but this time, redelivery finds pending, recognizes it as an unfinished attempt, and logs CLAIM RECOVERED instead of dropping it. It retries, and SENT push notif:<id> finally appears—exactly once.


---

Retries, backoff, and the dead-letter queue. User 999's device token is permanently invalid; the push provider rejects it every single time. Send it and watch the worker handle a message that can never succeed:

cd /root/lab3
./notify.sh --bad-token
sleep 6
docker compose logs push-worker | grep -E 'RETRY|DEAD-LETTER'
docker exec rabbitmq rabbitmqctl list_queues name messages

The log shows RETRY 1/3 (0.5s backoff) and RETRY 2/3 (1s backoff)—two retries after the initial attempt, 3 attempts in total. When the third attempt also fails, you'll seeDEAD-LETTER notif:<id> -> push.dlq. The poison message is parked in push.dlq for inspection and replay—it does not block the queue, and it does not retry forever.


You can see the push.dlq queue holding the parked message in the RabbitMQ Management UI (guest/guest).