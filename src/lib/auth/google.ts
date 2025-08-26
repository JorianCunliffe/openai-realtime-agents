// src/lib/auth/google.ts
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { encryptJSON, decryptJSON } from "@/lib/crypto";
import { OAuthProvider } from "@prisma/client";

// Lazy import Prisma so this works both with and without a local prisma wrapper.
async function getPrisma() {
  try {
    const mod = await import("@/lib/db"); // if you already export prisma here
    // @ts-ignore
    return mod.prisma ?? mod.default?.prisma ?? mod;
  } catch {
    const { PrismaClient } = await import("@prisma/client");
    // @ts-ignore
    if (!globalThis.__PRISMA__) globalThis.__PRISMA__ = new PrismaClient();
    // @ts-ignore
    return globalThis.__PRISMA__;
  }
}

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  // Calendar scopes (adjust if you only need read)
  "https://www.googleapis.com/auth/calendar",
];

export function inferOriginFromRequestHeaders(headers: Headers): string {
  const proto = headers.get("x-forwarded-proto") ?? "http";
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) throw new Error("Cannot infer origin: no Host header");
  return `${proto}://${host}`;
}

export function googleRedirectUriForOrigin(origin: string) {
  return `${origin}/api/auth/google/callback`;
}

export function createGoogleOAuthClient(origin?: string): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET missing");
  }
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ?? (origin ? googleRedirectUriForOrigin(origin) : undefined);
  if (!redirectUri) {
    throw new Error("Set GOOGLE_REDIRECT_URI or pass an origin to createGoogleOAuthClient()");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}
function resolveProviderEnum(name: string): OAuthProvider {
  // Works whether enum values are "google" or "GOOGLE" etc.
  const entries = Object.entries(OAuthProvider) as [string, string][];
  const hit = entries.find(([k, v]) => k.toLowerCase() === name || v.toLowerCase() === name);
  if (!hit) {
    throw new Error(`OAuthProvider enum does not include "${name}". Available: ${entries.map(([,v]) => v).join(", ")}`);
  }
  return (hit[1] as unknown) as OAuthProvider;
}






/**
 * Upsert an OAuthAccount row for Google with encrypted tokens.
 */
export async function upsertGoogleOAuthAccount(input: {
  userId: string;
  providerAccountId: string; // Google's user id (sub)
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null; // ms
}) {
  const prisma = await getPrisma();
  const providerEnum = resolveProviderEnum("google");

  // We store encrypted JSON payloads in `accessToken` and `refreshToken` columns.
  const accessTokenEnc = input.access_token
    ? encryptJSON({
        access_token: input.access_token,
        expiry_date: input.expiry_date ?? null,
        token_type: input.token_type ?? null,
        scope: input.scope ?? null,
      })
    : undefined;
  const refreshTokenEnc = input.refresh_token
    ? encryptJSON({ refresh_token: input.refresh_token })
    : undefined;

  // This matches a common custom schema:
  // model OAuthAccount { id, userId, provider, providerAccountId, accessToken, refreshToken, scope, tokenType, expiresAt, ... }
  return prisma.oAuthAccount.upsert({
    where: {
      // Prefer unique(provider, providerAccountId). If your unique is different (e.g., (userId, provider)), this still works because we also update userId.
      provider_providerAccountId: { 
        provider: providerEnum, 
        providerAccountId: input.providerAccountId 
      },
    },
    update: {
      userId: input.userId,
      ...(accessTokenEnc ? { accessToken: accessTokenEnc } : {}),
      ...(refreshTokenEnc ? { refreshToken: refreshTokenEnc } : {}),
      scope: input.scope ?? undefined,
      tokenType: input.token_type ?? undefined,
      expiresAt: input.expiry_date ? new Date(input.expiry_date) : undefined,
    },
    create: {
      userId: input.userId,
      provider: providerEnum,
      providerAccountId: input.providerAccountId,
      accessToken: accessTokenEnc ?? encryptJSON({}), // never null
      refreshToken: refreshTokenEnc ?? encryptJSON({}),
      scope: input.scope ?? null,
      tokenType: input.token_type ?? null,
      expiresAt: input.expiry_date ? new Date(input.expiry_date) : null,
    },
  });
}

/**
 * Returns an OAuth2Client with credentials set and refresh persistence wired up.
 * By default this will ensure there's a fresh access_token (refresh if needed).
 */
export async function getAuthorizedGoogleClient(
  userId: string,
  opts: { ensureFresh?: boolean } = { ensureFresh: true }
): Promise<OAuth2Client> {
  const prisma = await getPrisma();
  const providerEnum = resolveProviderEnum("google");
  const account = await prisma.oAuthAccount.findFirst({
    where: { userId, provider: providerEnum },
  });
  if (!account) throw new Error("No Google OAuth tokens found for this user");

  const origin = process.env.GOOGLE_REDIRECT_URI
    ? new URL(process.env.GOOGLE_REDIRECT_URI).origin
    : undefined;

  const client = createGoogleOAuthClient(origin);

  const accPayload = account.accessToken ? decryptJSON<any>(account.accessToken) : {};
  const refPayload = account.refreshToken ? decryptJSON<any>(account.refreshToken) : {};

  client.setCredentials({
    access_token: accPayload.access_token,
    refresh_token: refPayload.refresh_token,
    expiry_date: accPayload.expiry_date,
    token_type: accPayload.token_type ?? undefined,
    scope: accPayload.scope ?? undefined,
  });

  // Persist refreshed tokens automatically
  client.on("tokens", async (tokens) => {
    try {
      await upsertGoogleOAuthAccount({
        userId,
        providerAccountId: account.providerAccountId,
        access_token: tokens.access_token ?? accPayload.access_token ?? null,
        refresh_token: tokens.refresh_token ?? null, // Google only sends refresh_token on first consent or when explicitly prompted
        scope: tokens.scope ?? accPayload.scope ?? null,
        token_type: tokens.token_type ?? accPayload.token_type ?? null,
        expiry_date: tokens.expiry_date ?? null,
      });
    } catch (e) {
      console.error("Failed to persist refreshed Google tokens:", e);
    }
  });

  if (opts.ensureFresh) {
    // This forces google-auth-library to refresh if expired/near-expiry.
    await client.getAccessToken();
  }

  return client;
}
