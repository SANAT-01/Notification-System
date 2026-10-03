import type { Flags, LabEvent, QueueStat, WorkerStatus } from "../lib/types";

type Props = {
  queues: QueueStat[] | undefined;
  workers: WorkerStatus[] | undefined;
  keyCount: number | undefined;
  flags: Flags | null;
  events: LabEvent[];
  now: number;
};

const W = 136;
const H = 54;

type NodeDef = { x: number; y: number; label: string; kind: string };

const NODES: Record<string, NodeDef> = {
  producer: { x: 10, y: 96, label: "producer", kind: "service" },
  qpush: { x: 186, y: 26, label: "notify.push", kind: "queue" },
  qemail: { x: 186, y: 166, label: "notify.email", kind: "queue" },
  wpush: { x: 362, y: 26, label: "push-worker", kind: "service" },
  wemail: { x: 362, y: 166, label: "email-worker", kind: "service" },
  provider: { x: 574, y: 6, label: "provider", kind: "external" },
  redis: { x: 574, y: 96, label: "Redis", kind: "store" },
  dlq: { x: 574, y: 186, label: "push.dlq", kind: "queue" },
};

const right = (n: NodeDef) => [n.x + W, n.y + H / 2] as const;
const left = (n: NodeDef) => [n.x, n.y + H / 2] as const;

function Edge({ from, to, dashed, faded }: { from: NodeDef; to: NodeDef; dashed?: boolean; faded?: boolean }) {
  const [x1, y1] = right(from);
  const [x2, y2] = left(to);
  const d = `M ${x1} ${y1} C ${x1 + 34} ${y1}, ${x2 - 34} ${y2}, ${x2} ${y2}`;
  return (
    <path
      d={d}
      className={`map-edge${dashed ? " map-edge-dashed" : ""}${faded ? " map-edge-faded" : ""}`}
      markerEnd="url(#arrow)"
    />
  );
}

export function SystemMap({ queues, workers, keyCount, flags, events, now }: Props) {
  const queue = (name: string) => queues?.find((q) => q.name === name);
  const workerUp = (name: string) => workers?.find((w) => w.name === name)?.up;
  const recentlyActive = (service: string) =>
    events.some((e) => e.service === service && now - e.ts < 1500 && e.ts <= now + 1000);

  const queueStat = (name: string) => {
    const q = queue(name);
    return q ? `${q.ready} ready · ${q.unacked} unacked` : "—";
  };
  const workerStat = (name: string) => {
    const up = workerUp(name);
    return up === undefined ? "—" : up ? "up" : "down / restarting";
  };
  const dedupeOn = flags?.idempotency ?? false;

  const stats: Record<string, string> = {
    producer: "POST /notify",
    qpush: queueStat("notify.push"),
    qemail: queueStat("notify.email"),
    wpush: workerStat("push-worker"),
    wemail: workerStat("email-worker"),
    provider: "simulated send",
    redis: keyCount === undefined ? "—" : `${keyCount} idempotency key${keyCount === 1 ? "" : "s"}`,
    dlq: queue("push.dlq") ? `${queue("push.dlq")!.ready} parked` : "—",
  };

  const nodeClass = (id: string) => {
    const n = NODES[id];
    const classes = ["map-node", `map-node-${n.kind}`];
    if ((id === "wpush" && workerUp("push-worker") === false) || (id === "wemail" && workerUp("email-worker") === false)) {
      classes.push("map-node-down");
    }
    const service = id === "producer" ? "producer" : id === "wpush" ? "push-worker" : id === "wemail" ? "email-worker" : null;
    if (service && recentlyActive(service)) classes.push("map-node-active");
    if (id === "redis" && !dedupeOn) classes.push("map-node-idle");
    if (id === "dlq" && (queue("push.dlq")?.ready ?? 0) > 0) classes.push("map-node-warn");
    return classes.join(" ");
  };

  return (
    <div>
      <svg className="map" viewBox="0 0 720 246" role="img" aria-label="Live system map of the notification pipeline">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="map-arrow" />
          </marker>
        </defs>

        <Edge from={NODES.producer} to={NODES.qpush} />
        <Edge from={NODES.producer} to={NODES.qemail} />
        <Edge from={NODES.qpush} to={NODES.wpush} />
        <Edge from={NODES.qemail} to={NODES.wemail} />
        <Edge from={NODES.wpush} to={NODES.provider} />
        <Edge from={NODES.wemail} to={NODES.provider} />
        <Edge from={NODES.wpush} to={NODES.redis} dashed faded={!dedupeOn} />
        <Edge from={NODES.wemail} to={NODES.redis} dashed faded={!dedupeOn} />
        <Edge from={NODES.wpush} to={NODES.dlq} dashed />

        {Object.entries(NODES).map(([id, n]) => (
          <g key={id} className={nodeClass(id)}>
            <rect x={n.x} y={n.y} width={W} height={H} rx={9} />
            <text x={n.x + W / 2} y={n.y + 22} className="map-label">
              {n.label}
            </text>
            <text x={n.x + W / 2} y={n.y + 40} className="map-stat">
              {stats[id]}
            </text>
          </g>
        ))}
      </svg>
      <div className="map-legend">
        <span>
          <i className="legend-swatch legend-active" /> active now
        </span>
        <span>
          <i className="legend-swatch legend-idle" /> dedupe path off
        </span>
        <span>
          <i className="legend-swatch legend-warn" /> messages parked
        </span>
        <span>
          <i className="legend-swatch legend-down" /> worker down
        </span>
      </div>
    </div>
  );
}
