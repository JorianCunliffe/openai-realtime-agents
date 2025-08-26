// src/app/api/auth/google/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  createGoogleOAuthClient,
  GOOGLE_SCOPES,
  inferOriginFromRequestHeaders,
} from "@/lib/auth/google";
// keep your helper; adjust the import path if needed
import { getSessionId } from "@/lib/session";

async function getOptionalUserId(): Promise<string | null> {
  const sid = await getSessionId();
  if (!sid) return null;
  const { PrismaClient } = await import("@prisma/client");
  // cache prisma on global to avoid hot-reload churn
  if (!(globalThis as any).__PRISMA__) (globalThis as any).__PRISMA__ = new PrismaClient();
  const prisma = (globalThis as any).__PRISMA__ as InstanceType<typeof PrismaClient>;
  const s = await prisma.session.findUnique({ where: { id: sid }, select: { userId: true } });
  return s?.userId ?? null;
}


export async function GET(req: NextRequest) {
  try {
    const userId = await getOptionalUserId();

    // Stateless CSRF: include mode so callback knows whether to link or sign in
    const payload = { v: 1, ts: Date.now(), userId, mode: userId ? ("link" as const) : ("signin" as const) };
    const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET || "";
    if (!secret) throw new Error("SESSION_SECRET is not set");
    const sig = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(payload))
      .digest("base64url");
    const stateB64 = Buffer.from(JSON.stringify({ p: payload, s: sig }), "utf8").toString(
      "base64url"
    );

    // Prefer an explicit redirect origin from env (stable on Replit),
    // otherwise infer from the incoming request.
    const origin =
      process.env.GOOGLE_REDIRECT_URI
        ? new URL(process.env.GOOGLE_REDIRECT_URI).origin
        : inferOriginFromRequestHeaders(req.headers);

    const oauth2 = createGoogleOAuthClient(origin);
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_SCOPES,
      state: stateB64,
    });

    // No CSRF cookie needed
    return NextResponse.redirect(url);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 });
  }
}
