"use client";

import { useMemo, useState } from "react";
import type { Flags, KeyEntry, LabEvent, QueueStat } from "../lib/types";
import { EventList, grepMatcher } from "./EventList";
import { CopyButton } from "./CopyButton";

export function FlagsPanel({ flags, onChange }: { flags: Flags | null; onChange: (next: Flags) => void }) {
  return (
    <section className="card panel">
      <h2>Worker flags</h2>
      <p className="muted small">
        Stored in Redis <code>lab:flags</code>; both workers read them per message. This replaces editing
        docker-compose.yml and recreating the workers.
      </p>
      <Toggle
        name="IDEMPOTENCY_ENABLED"
        hint="Claim notification:<id>:<channel>:<user> in Redis before sending."
        checked={flags?.idempotency ?? false}
        disabled={!flags}
        onChange={(v) => flags && onChange({ ...flags, idempotency: v })}
      />
      <Toggle
        name="CLAIM_LEASE_ENABLED"
        hint="Two-state claim: pending (10s lease) → done (24h). Only matters with idempotency on."
        checked={flags?.claimLease ?? false}
        disabled={!flags}
        onChange={(v) => flags && onChange({ ...flags, claimLease: v })}
      />
    </section>
  );
}

function Toggle(props: { name: string; hint: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="toggle-track" aria-hidden />
      <span>
        <code>{props.name}</code>
        <span className="muted small block">{props.hint}</span>
      </span>
    </label>
  );
}

export function QueuesPanel({ queues, error }: { queues: QueueStat[] | undefined; error: string | null }) {
  return (
    <section className="card panel">
      <h2>Queues</h2>
      {error && <p className="error-text small">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>queue</th>
            <th>ready</th>
            <th>unacked</th>
            <th>consumers</th>
          </tr>
        </thead>
        <tbody>
          {(queues ?? []).map((q) => (
            <tr key={q.name} className={q.name.endsWith(".dlq") && q.ready > 0 ? "row-warn" : ""}>
              <td>
                <code>{q.name}</code>
              </td>
              <td>{q.ready}</td>
              <td>{q.unacked}</td>
              <td>{q.consumers}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        RabbitMQ refreshes these stats every ~5s. Full detail in the{" "}
        <a href="http://localhost:15672" target="_blank" rel="noopener noreferrer">
          management UI
        </a>{" "}
        (guest / guest).
      </p>
    </section>
  );
}

export function KeysPanel({ keys }: { keys: KeyEntry[] | undefined }) {
  const label = (value: string | null) => (value === "1" ? "claimed" : value ?? "—");
  return (
    <section className="card panel">
      <h2>Redis idempotency keys</h2>
      {!keys?.length ? (
        <p className="muted small">No keys yet — turn on IDEMPOTENCY_ENABLED and send something.</p>
      ) : (
        <ul className="keys">
          {keys.map((k) => (
            <li key={k.key}>
              <code className="key-name">{k.key}</code>
              <span className={`badge badge-${label(k.value)}`}>{label(k.value)}</span>
              <span className="muted small">TTL {k.ttl}s</span>
              <CopyButton text={k.key} label="Copy key" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type DlqMessage = { payload: unknown };

export function DlqPanel({ onPurged }: { onPurged: () => void }) {
  const [messages, setMessages] = useState<DlqMessage[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function inspect() {
    setStatus("Loading…");
    const res = await fetch("/api/lab/dlq/push", { cache: "no-store" });
    const body = await res.json();
    if (res.ok) {
      setMessages(body.messages);
      setStatus(null);
    } else {
      setStatus(body.error ?? "Failed to read push.dlq");
    }
  }

  async function purge() {
    const res = await fetch("/api/lab/dlq/push", { method: "DELETE" });
    setMessages([]);
    setStatus(res.ok ? "push.dlq purged." : "Purge failed.");
    onPurged();
  }

  return (
    <section className="card panel">
      <h2>Dead-letter queue</h2>
      <p className="muted small">
        Peek at messages parked in <code>push.dlq</code> without consuming them. In production you&apos;d fix the
        cause (e.g. refresh the device token) and replay them.
      </p>
      <div className="row">
        <button className="button button-secondary" onClick={inspect}>
          Inspect push.dlq
        </button>
        <button className="button button-ghost" onClick={purge}>
          Purge
        </button>
      </div>
      {status && <p className="muted small">{status}</p>}
      {messages && messages.length === 0 && !status && <p className="muted small">push.dlq is empty.</p>}
      {messages && messages.length > 0 && <pre className="dlq">{JSON.stringify(messages.map((m) => m.payload), null, 2)}</pre>}
    </section>
  );
}

export function EventStreamPanel({ events, onClear }: { events: LabEvent[]; onClear: () => void }) {
  const [grep, setGrep] = useState("");
  const filtered = useMemo(() => events.filter(grepMatcher(grep)), [events, grep]);
  return (
    <section className="card panel">
      <div className="row row-between">
        <h2>Event stream</h2>
        <button className="button button-ghost" onClick={onClear}>
          Clear view
        </button>
      </div>
      <input
        className="input"
        placeholder="grep -E  e.g. SENT|CRASH|DUPLICATE"
        value={grep}
        onChange={(e) => setGrep(e.target.value)}
      />
      <EventList events={filtered} empty="No events yet." />
    </section>
  );
}
