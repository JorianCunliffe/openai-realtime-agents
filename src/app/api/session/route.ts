// src/app/api/session/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const DEFAULT_MODEL =
  process.env.REALTIME_MODEL ||
  "gpt-realtime";

async function createEphemeralSession(initBody: Record<string, any>) {
  const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "realtime=v1",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      ...initBody, // allows overrides (voice, modalities, etc.) when using POST
    }),
  });

  if (!r.ok) {
    let detail = "";
    try {
      detail = await r.text();
    } catch {}
    throw new Error(
      `OpenAI session failed (${r.status} ${r.statusText})${
        detail ? `: ${detail}` : ""
      }`
    );
  }

  return r.json();
}

async function buildMeta(req: NextRequest) {
  const cookieStore = await cookies();
  const sid = cookieStore.get("sid")?.value || null;           // browser flow
  const userId = req.headers.get("x-user-id") || null;         // Twilio/server flow
  return {
    attachCalendar: Boolean(sid || userId), // Step 6 hint only; not sensitive
    hasSid: Boolean(sid),
    hasUserId: Boolean(userId),
  };
}

// KEEP your existing GET behavior (drop-in)
export async function GET(req: NextRequest) {
  try {
    const data = await createEphemeralSession({});
    return NextResponse.json({ ok: true, ...data, meta: await buildMeta(req) });
  } catch (error: any) {
    console.error("Error in /api/session GET:", error);
    return NextResponse.json(
      { ok: false, message: error?.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}

// Optional: POST lets you pass session.update fields (voice, modalities, etc.)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const data = await createEphemeralSession(body || {});
    return NextResponse.json({ ok: true, ...data, meta: await buildMeta(req) });
  } catch (error: any) {
    console.error("Error in /api/session POST:", error);
    return NextResponse.json(
      { ok: false, message: error?.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
