"use client";

import { useState } from "react";
import type { Flags, LabEvent, StepRun } from "../lib/types";
import type { StepDef, Verdict } from "../lib/steps";
import { EventList, grepMatcher } from "./EventList";
import { CopyButton } from "./CopyButton";

type Props = {
  step: StepDef;
  run: StepRun | undefined;
  stepEvents: LabEvent[];
  verdict: Verdict | null;
  flags: Flags | null;
  now: number;
  busy: boolean;
  onApplyFlags: (flags: Flags) => void;
  onFire: () => void;
};

const flagsMatch = (a: Flags | null, b: Flags | null) =>
  !!a && !!b && a.idempotency === b.idempotency && a.claimLease === b.claimLease;

const VERDICT_LABEL = { ok: "Observed", bug: "Bug reproduced", fixed: "Fixed" } as const;

export function StepCard({ step, run, stepEvents, verdict, flags, now, busy, onApplyFlags, onFire }: Props) {
  const [showAll, setShowAll] = useState(false);
  const setupOk = step.flags === null || flagsMatch(step.flags, flags);
  const timedOut = !!run && !verdict && now - run.firedAt > step.timeoutMs;

  let status: { label: string; className: string };
  let accent: string;
  if (!run) {
    status = { label: "Not started", className: "pill" };
    accent = "accent-pending";
  } else if (verdict) {
    status = { label: VERDICT_LABEL[verdict.kind], className: `pill pill-${verdict.kind}` };
    accent = `accent-${verdict.kind}`;
  } else if (timedOut) {
    status = { label: "Not observed", className: "pill pill-warn" };
    accent = "accent-warn";
  } else {
    status = { label: "Watching…", className: "pill pill-running" };
    accent = "accent-running";
  }

  const shown = showAll || !step.grep ? stepEvents : stepEvents.filter(grepMatcher(step.grep));

  return (
    <section className={`card step ${accent}`} id={step.id}>
      <header className="step-header">
        <span className="step-number">{step.number}</span>
        <h2>{step.title}</h2>
        <span className={status.className}>{status.label}</span>
      </header>

      <p className="step-concept">{step.concept}</p>

      <div className="step-block">
        <h3>Setup</h3>
        {step.flags ? (
          <>
            <div className="flag-reqs">
              <FlagReq name="IDEMPOTENCY_ENABLED" want={step.flags.idempotency} have={flags?.idempotency} />
              <FlagReq name="CLAIM_LEASE_ENABLED" want={step.flags.claimLease} have={flags?.claimLease} />
            </div>
            {!setupOk && (
              <button className="button button-secondary" onClick={() => onApplyFlags(step.flags!)}>
                Apply setup
              </button>
            )}
          </>
        ) : (
          <p className="muted">No flag changes needed — works with any setting.</p>
        )}
      </div>

      <div className="step-block">
        <h3>Run</h3>
        <p>{step.action}</p>
        <div className="row">
          <button className="button" disabled={busy} onClick={onFire}>
            {busy ? "Firing…" : run ? "Run again" : "Run step"}
          </button>
          {!setupOk && <span className="warn-text">Current flags differ from this step&apos;s setup — results will differ.</span>}
        </div>
      </div>

      <div className="step-block">
        <h3>What to look for</h3>
        <p>{step.expect}</p>
      </div>

      {run && (
        <div className="step-block">
          <div className="row row-between">
            <h3>
              Worker logs for notif:{run.notifId}
              {step.grep && !showAll && <code className="grep">grep -E &apos;{step.grep}&apos;</code>}
            </h3>
            {step.grep && (
              <label className="checkbox">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                show all
              </label>
            )}
          </div>
          <EventList events={shown} empty="Waiting for worker events…" />

          {verdict && (
            <div className={`verdict verdict-${verdict.kind}`}>
              <strong>{verdict.title}</strong>
              <p>{verdict.detail}</p>
              <p className="takeaway">
                <b>Takeaway:</b> {step.takeaway}
              </p>
            </div>
          )}
          {timedOut && (
            <div className="verdict verdict-warn">
              <strong>Expected outcome not observed yet</strong>
              <p>
                {step.flags && !flagsMatch(step.flags, run.flagsAtFire)
                  ? "The flags when you fired didn't match this step's setup. Apply the setup and run again."
                  : "Check the worker status in the system map and the full event stream, then run again."}
              </p>
            </div>
          )}
        </div>
      )}

      <details className="cli">
        <summary>Equivalent CLI</summary>
        <div className="cli-body">
          <pre>{step.cli.join("\n")}</pre>
          <CopyButton text={step.cli.join("\n")} />
        </div>
      </details>
    </section>
  );
}

function FlagReq({ name, want, have }: { name: string; want: boolean; have: boolean | undefined }) {
  const ok = have === want;
  return (
    <div className={`flag-req ${ok ? "flag-req-ok" : "flag-req-bad"}`}>
      <code>{name}</code>
      <span>
        needs <b>{want ? "on" : "off"}</b> · now {have === undefined ? "?" : have ? "on" : "off"} {ok ? "✓" : "✗"}
      </span>
    </div>
  );
}
