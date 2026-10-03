"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LabEvent } from "./types";

export function usePolling<T>(url: string, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(url, { cache: "no-store" });
      const body = await res.json();
      if (res.ok) {
        setData(body as T);
        setError(null);
      } else {
        setError(body.error ?? res.statusText);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      inFlight.current = false;
    }
  }, [url]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}

/** Tails the worker event stream: initial backlog, then only newer entries. */
export function useLabEvents(intervalMs = 1000) {
  const [events, setEvents] = useState<LabEvent[]>([]);
  const cursor = useRef<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const qs = cursor.current ? `?since=${encodeURIComponent(cursor.current)}` : "";
        const res = await fetch(`/api/lab/events${qs}`, { cache: "no-store" });
        if (!res.ok) return;
        const body: { events: LabEvent[]; cursor: string | null } = await res.json();
        if (body.cursor) cursor.current = body.cursor;
        if (body.events.length) setEvents((prev) => [...prev, ...body.events].slice(-600));
      } catch {
        // transient — next tick retries
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  const clear = useCallback(() => setEvents([]), []);
  return { events, clear };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
