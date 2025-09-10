"use client";

// src/lib/realtime/bootstrapClient.ts
// Helper to fetch an ephemeral Realtime session token + meta.

export type EphemeralSessionMeta = {
  attachCalendar?: boolean;
  hasSid?: boolean;
  hasUserId?: boolean;
};

export async function getEphemeralSessionPayload(): Promise<{
  token: string;
  meta?: EphemeralSessionMeta;
  raw: any;
}> {
  const res = await fetch("/api/session", { method: "GET", credentials: "include" });
  const j = await res.json();
  if (!j?.client_secret?.value) {
    throw new Error(j?.message || "Failed to create ephemeral session");
  }
  return { token: j.client_secret.value, meta: j.meta, raw: j };
}
