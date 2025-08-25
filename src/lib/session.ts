// src/lib/session.ts
import { cookies } from "next/headers";
import crypto from "node:crypto";

/**
 * Signed session cookie utilities.
 * Creates a browser cookie "sid" whose value is `${id}.${hmac(id)}`
 * so you can trust it without a DB lookup.
 */

const COOKIE_NAME = "sid";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Use SESSION_SECRET (or NEXTAUTH_SECRET if you already have it set)
const SECRET = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;

function assertSecret(): string {
  if (!SECRET) throw new Error("SESSION_SECRET is not set");
  return SECRET;
}

function sign(value: string): string {
  return crypto.createHmac("sha256", assertSecret()).update(value).digest("base64url");
}

/** Verify a signed value of the shape `${id}.${sig}`. Returns id if valid, else null. */
function verify(signed: string | undefined | null): string | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return null;
  const id = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  return sign(id) === sig ? id : null;
}

/** Generate a new opaque session id. */
export function newSessionId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

/** Read and verify the current request's sid cookie. Returns the id or null. */
export function getSessionId(): string | null {
  const raw = cookies().get(COOKIE_NAME)?.value;
  return verify(raw);
}

/** Set a signed sid cookie for the current response. */
export function setSessionId(id: string) {
  const value = `${id}.${sign(id)}`;
  cookies().set({
    name: COOKIE_NAME,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

/** Clear the sid cookie. */
export function clearSession() {
  cookies().delete(COOKIE_NAME);
}
