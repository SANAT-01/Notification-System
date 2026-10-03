import { NextResponse } from "next/server";

// Server-only: the browser never sees this URL or talks to the producer
// directly. PRODUCER_URL resolves over the internal Docker network
// (e.g. http://producer:3000), so the producer is never published to the host.
const PRODUCER_URL = process.env.PRODUCER_URL ?? "http://producer:3000";

const ALLOWED_MODES = new Set(["default", "crash", "crash-claim", "bad-token"]);

export async function POST(request: Request) {
  let mode = "default";
  try {
    const body = await request.json();
    if (typeof body?.mode === "string") mode = body.mode;
  } catch {
    // no/invalid JSON body -> fall back to "default"
  }

  if (!ALLOWED_MODES.has(mode)) {
    return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${PRODUCER_URL}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
      cache: "no-store",
    });

    const payload = await upstream.json().catch(() => ({}));
    return NextResponse.json(payload, { status: upstream.status });
  } catch (err) {
    console.error("failed to reach producer", err);
    return NextResponse.json({ error: "producer_unreachable" }, { status: 502 });
  }
}
