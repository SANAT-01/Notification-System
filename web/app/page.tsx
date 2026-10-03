"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SystemMap } from "./components/SystemMap";
import { StepCard } from "./components/StepCard";
import { DlqPanel, EventStreamPanel, FlagsPanel, KeysPanel, QueuesPanel } from "./components/Panels";
import { ThemeToggle } from "./components/ThemeToggle";
import { ToastStack, type ToastItem } from "./components/Toast";
import { useLabEvents, useNow, usePolling } from "./lib/hooks";
import { STEPS, type StepDef } from "./lib/steps";
import type { Flags, KeyEntry, LabEvent, QueueStat, StepRun, WorkerStatus } from "./lib/types";

const RESTART_WINDOW_MS = 20_000;

function eventsForRun(events: LabEvent[], run: StepRun | undefined) {
  if (!run) return [];
  return events.filter(
    (e) =>
      e.notifId === run.notifId ||
      (e.type === "WORKER_READY" && e.ts >= run.firedAt && e.ts <= run.firedAt + RESTART_WINDOW_MS),
  );
}

export default function Home() {
  const { events, clear } = useLabEvents();
  const now = useNow();
  const flagsQ = usePolling<{ flags: Flags }>("/api/lab/flags", 2000);
  const queuesQ = usePolling<{ queues: QueueStat[] }>("/api/lab/queues", 2000);
  const keysQ = usePolling<{ keys: KeyEntry[] }>("/api/lab/keys", 2000);
  const workersQ = usePolling<{ workers: WorkerStatus[] }>("/api/lab/workers", 2000);

  const [runs, setRuns] = useState<Record<string, StepRun>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);

  // Pinned to the top of the viewport so it's visible without scrolling after
  // firing a step further down the page. Collapsible since pinned + expanded
  // eats a lot of vertical space; the choice is remembered per browser.
  const [mapOpen, setMapOpen] = useState(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("lab-map-open");
      if (saved !== null) setMapOpen(saved === "true");
    } catch {
      // ignore
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("lab-map-open", String(mapOpen));
    } catch {
      // ignore
    }
  }, [mapOpen]);

  const flags = flagsQ.data?.flags ?? null;

  const pushToast = useCallback((text: string, kind: ToastItem["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  async function applyFlags(next: Flags) {
    const res = await fetch("/api/lab/flags", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!res.ok) pushToast("Couldn't update flags — is the producer up?", "error");
    else pushToast("Flags updated.", "success");
    await flagsQ.refresh();
  }

  async function fire(step: StepDef) {
    setBusy(step.id);
    try {
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: step.mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setRuns((prev) => ({ ...prev, [step.id]: { notifId: data.id, firedAt: Date.now(), flagsAtFire: flags } }));
    } catch (err) {
      pushToast(`Couldn't fire the event: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!confirm("Reset the lab? Flags go back to off, idempotency keys, events and all queues are cleared.")) return;
    const res = await fetch("/api/lab/reset", { method: "POST" });
    pushToast(res.ok ? "Lab reset — flags off, keys/queues/events cleared." : "Reset failed.", res.ok ? "success" : "error");
    clear();
    setRuns({});
    await Promise.all([flagsQ.refresh(), queuesQ.refresh(), keysQ.refresh()]);
  }

  const results = STEPS.map((step) => {
    const run = runs[step.id];
    const stepEvents = eventsForRun(events, run);
    return { step, run, stepEvents, verdict: run ? step.evaluate(stepEvents) : null };
  });
  const completed = results.filter((r) => r.verdict).length;

  function jumpTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="page">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <header className="topbar">
        <div>
          <h1>Notification System Lab</h1>
          <p className="muted">
            One event, queue-per-channel fan-out, at-least-once delivery, idempotency, and dead-lettering — break it
            the way production breaks, then fix it.
          </p>
        </div>
        <div className="row">
          <a className="button button-secondary" href="http://localhost:15672" target="_blank" rel="noopener noreferrer">
            RabbitMQ UI
          </a>
          <button className="button button-ghost" onClick={reset}>
            Reset lab
          </button>
          <ThemeToggle />
        </div>
      </header>

      <section className={`card map-card${mapOpen ? "" : " map-card-collapsed"}`}>
        <div className="row row-between">
          <h2>System map</h2>
          <div className="row">
            <span className="muted small map-hint">live · nodes pulse when they log an event</span>
            <button className="button button-ghost icon-button" onClick={() => setMapOpen((v) => !v)}>
              {mapOpen ? "Collapse ▲" : "Expand ▼"}
            </button>
          </div>
        </div>
        {mapOpen && (
          <div className="map-scroll">
            <SystemMap
              queues={queuesQ.data?.queues}
              workers={workersQ.data?.workers}
              keyCount={keysQ.data?.keys.length}
              flags={flags}
              events={events}
              now={now}
            />
          </div>
        )}
      </section>

      <div className="layout">
        <main className="steps">
          <nav className="card progress">
            <div className="row row-between">
              <h2>Lab scenarios</h2>
              <span className="muted small">
                {completed} / {STEPS.length} observed
              </span>
            </div>
            <p className="muted small">Each one is independent — jump to whichever you want, in any order.</p>
            <ol>
              {results.map(({ step, verdict }) => (
                <li key={step.id} className={verdict ? "done" : ""}>
                  <a href={`#${step.id}`} onClick={(e) => { e.preventDefault(); jumpTo(step.id); }}>
                    {step.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          {results.map(({ step, run, stepEvents, verdict }) => (
            <StepCard
              key={step.id}
              step={step}
              run={run}
              stepEvents={stepEvents}
              verdict={verdict}
              flags={flags}
              now={now}
              busy={busy !== null}
              onApplyFlags={applyFlags}
              onFire={() => fire(step)}
            />
          ))}
        </main>

        <aside className="sidebar">
          <FlagsPanel flags={flags} onChange={applyFlags} />
          <QueuesPanel queues={queuesQ.data?.queues} error={queuesQ.error} />
          <KeysPanel keys={keysQ.data?.keys} />
          <DlqPanel onPurged={queuesQ.refresh} />
          <EventStreamPanel events={events} onClear={clear} />
        </aside>
      </div>
    </div>
  );
}
