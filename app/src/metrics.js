import client from "prom-client";

client.collectDefaultMetrics();

export const registry = client.register;

export const notificationsTotal = new client.Counter({
  name: "notifications_total",
  help: "Notifications processed by channel and outcome",
  labelNames: ["channel", "outcome"],
});

export const retriesTotal = new client.Counter({
  name: "notification_retries_total",
  help: "Provider send retries by channel",
  labelNames: ["channel"],
});

export const publishedTotal = new client.Counter({
  name: "notifications_published_total",
  help: "Notifications published by the producer, by queue",
  labelNames: ["queue"],
});
