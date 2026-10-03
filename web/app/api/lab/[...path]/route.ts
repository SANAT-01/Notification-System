import { NextRequest, NextResponse } from "next/server";

// Server-side proxy to the producer's /lab API over the Docker network.
const PRODUCER_URL = process.env.PRODUCER_URL ?? "http://producer:3000";
const ALLOWED_ROOTS = new Set(["events", "flags", "keys", "queues", "dlq", "workers", "reset"]);

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: Context) {
  const { path } = await context.params;
  if (!path.length || !ALLOWED_ROOTS.has(path[0])) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const target = `${PRODUCER_URL}/lab/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  const hasBody = request.method === "PUT" || request.method === "POST";

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? await request.text() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const payload = await upstream.json().catch(() => ({}));
    return NextResponse.json(payload, { status: upstream.status });
  } catch (err) {
    console.error("failed to reach producer lab api", err);
    return NextResponse.json({ error: "producer_unreachable" }, { status: 502 });
  }
}

export { proxy as GET, proxy as PUT, proxy as POST, proxy as DELETE };
