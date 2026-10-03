import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./logger.js";
import { registry } from "./metrics.js";

/**
 * Base Express app shared by the producer and the workers: security headers,
 * JSON body parsing with a small size cap, structured request logging, and
 * the three endpoints any prod service needs for orchestration —
 * liveness (/healthz), readiness (/readyz), and scrape-able metrics (/metrics).
 */
export function createBaseApp({ readiness } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "32kb" }));
  app.use(pinoHttp({ logger }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (req, res) => {
    try {
      const ready = readiness ? await readiness() : true;
      res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not-ready" });
    } catch (err) {
      req.log.error({ err }, "readiness check failed");
      res.status(503).json({ status: "not-ready" });
    }
  });

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  return app;
}

/** Standard JSON 404 + error handlers. Mount after all routes. */
export function notFoundHandler(_req, res) {
  res.status(404).json({ error: "not_found" });
}

export function errorHandler(err, req, res, _next) {
  req.log?.error({ err }, "unhandled request error");
  res.status(err.status || 500).json({ error: err.publicMessage || "internal_error" });
}
