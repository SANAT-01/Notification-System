"use client";

import { useEffect, useRef } from "react";
import type { LabEvent } from "../lib/types";

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Compiles a grep-style pattern; an invalid regex falls back to a plain substring match. */
export function grepMatcher(pattern: string): (e: LabEvent) => boolean {
  if (!pattern.trim()) return () => true;
  try {
    const re = new RegExp(pattern);
    return (e) => re.test(e.message);
  } catch {
    return (e) => e.message.includes(pattern);
  }
}

export function EventList({ events, empty, autoScroll = true }: { events: LabEvent[]; empty: string; autoScroll?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length, autoScroll]);

  return (
    <div className="events" ref={ref}>
      {events.length === 0 && <div className="muted">{empty}</div>}
      {events.map((e) => (
        <div key={e.id} className={`event event-${e.type}`}>
          <span className="event-time">{time(e.ts)}</span>
          <span className="event-service">{e.service}</span>
          <span className="event-message">{e.message}</span>
        </div>
      ))}
    </div>
  );
}
