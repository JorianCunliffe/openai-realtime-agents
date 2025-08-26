// src/app/api/auth/google/callback/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import {
  createGoogleOAuthClient,
  inferOriginFromRequestHeaders,
  upsertGoogleOAuthAccount,
} from "@/lib/auth/google";
import { setSessionId } from "@/lib/session";

type StateV1 = {
  v: 1;
  ts: number;                // ms since epoch
  userId?: string | null;    // present when we were in "link" mode
  mode?: "link" | "signin";  // optional (we infer if absent)
};

export async function GET(req: NextRequest) {
  try {
    // Prefer explicit redirect origin (stable on Replit), else infer from request
    const origin =
      process.env.GOOGLE_REDIRECT_URI
        ? new URL(process.env.GOOGLE_REDIRECT_URI).origin
        : inferOriginFromRequestHeaders(req.headers);

    const oauth2 = createGoogleOAuthClient(origin);

    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const stateB64 = searchParams.get("state");
    if (!code || !stateB64) throw new Error("Missing code/state");

    // --- Verify stateless CSRF via signed state ---
    const raw = JSON.parse(Buffer.from(stateB64, "base64url").toString("utf8")) as {
      p: StateV1;
      s: string;
    };
    const payload: StateV1 = {
      ...raw.p,
      mode: raw.p.mode ?? (raw.p.userId ? "link" : "signin"),
    };
    const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET || "";
    if (!secret) throw new Error("SESSION_SECRET is not set");

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(payload))
      .digest("base64url");
    if (raw.s !== expectedSig) throw new Error("CSRF validation failed (bad state signature)");
    if (Date.now() - payload.ts > 10 * 60 * 1000) {
      throw new Error("CSRF validation failed (state expired)");
    }

    // --- Exchange code for tokens ---
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    // --- Read Google profile (id + email) ---
    const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
    const me = await oauth2Api.userinfo.get();
    const providerAccountId = me.data.id ?? "";
    const email = (me.data.email || undefined)?.toLowerCase();
    const name = me.data.name || undefined;
    if (!providerAccountId) throw new Error("Could not resolve Google user id");

    // --- Lazy Prisma (inside handler only; safe for deploy) ---
    const { PrismaClient, OAuthProvider } = await import("@prisma/client");
    // cache one client per process
    // @ts-ignore
    const prisma: InstanceType<typeof PrismaClient> =
      (globalThis as any).__PRISMA__ ?? ((globalThis as any).__PRISMA__ = new PrismaClient());

    // resolve the enum value for "google" regardless of casing
    const providerEnum = (() => {
      const entries = Object.entries(OAuthProvider) as [string, string][];
      const hit = entries.find(([k, v]) => k.toLowerCase() === "google" || v.toLowerCase() === "google");
      if (!hit) throw new Error("OAuthProvider enum missing 'google'");
      return hit[1] as unknown as (typeof OAuthProvider)[keyof typeof OAuthProvider];
    })();

    // --- Decide which user to bind to ---
    let userId: string | null = null;

    if (payload.mode === "link" && payload.userId) {
      // Link to the existing signed-in user, if it still exists
      const u = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (u) userId = u.id;
      // if it doesn't exist anymore, we'll fall through to sign-in logic
    }

    if (!userId) {
      // Sign-in path: reuse existing Google link → user, else create user (or reuse by email)
      const existingAccount = await prisma.oAuthAccount.findUnique({
        where: {
          provider_providerAccountId: {
            provider: providerEnum,
            providerAccountId,
          },
        },
        select: { userId: true },
      });

      if (existingAccount) {
        userId = existingAccount.userId;
      } else {
        // Optional: merge by email if your schema enforces unique emails
        let user =
          email ? await prisma.user.findUnique({ where: { email } }).catch(() => null) : null;

        if (!user) {
          // Create a minimal user. If your schema requires more fields, add them here.
          user = await prisma.user.create({
            data: {
              id: randomUUID(),
              // Add required fields for your schema:
              // e.g., email is nullable in many schemas; if it's required in yours, ensure it's present
              email: email ?? null,
              name: name ?? null,
            } as any,
          });
        }

        userId = user.id;

        // Start a session for this new/located user (so they're logged in after callback)
        const sid = randomUUID();
        await prisma.session.create({ data: { id: sid, userId } });
        await setSessionId(sid);
      }
    }

    if (!userId) throw new Error("Could not resolve user to attach Google account");

    // --- Save encrypted tokens under that user (upsert) ---
    await upsertGoogleOAuthAccount({
      userId,
      providerAccountId,
      access_token: tokens.access_token ?? null,
      refresh_token: tokens.refresh_token ?? null, // Google sends this only on first consent
      scope: tokens.scope ?? null,
      token_type: tokens.token_type ?? null,
      expiry_date: tokens.expiry_date ?? null,
    });

    // Done — back to app
    return NextResponse.redirect(
      new URL("/?google=connected", process.env.CANONICAL_BASE_URL || origin)
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 });
  }
}
