// src/lib/realtime/bootstrapClient.ts
// Client bootstrap for OpenAI Realtime + Step 6 tool injection.

import { createSession } from "@/lib/realtime/createSession";
// If you keep agent configs elsewhere, adjust this import:
import { CURRENT_SCENARIO_AGENTS } from "@/app/agents"; // ← update to your actual path

type EphemeralSessionResponse = {
  ok: boolean;
  client_secret?: { value: string; expires_at: number };
  meta?: {
    attachCalendar: boolean;
    hasSid: boolean;
    hasUserId: boolean;
  };
  // plus whatever OpenAI returns (id, model, etc.)
};

function getSidFromBrowser(): string | undefined {
  // 1) URL ?sid=...
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("sid");
    if (fromUrl) return fromUrl;
  } catch {}
  // 2) Cookie sid=...
  try {
    const m = document.cookie.match(/(?:^|;\s*)sid=([^;]+)/);
    if (m?.[1]) return decodeURIComponent(m[1]);
  } catch {}
  // 3) localStorage
  try {
    const fromLs = localStorage.getItem("sid");
    if (fromLs) return fromLs;
  } catch {}
  return undefined;
}

/**
 * Fetch an ephemeral token from /api/session and initialize a Realtime session.
 * Returns the connected session instance.
 */
export async function bootstrapRealtimeClient(options?: {
  agents?: any[];           // allow custom scenario agents
  apiBase?: string;         // overrides base for your /api/google/calendar/* endpoints
  model?: string;           // if you want to pin a model client-side
  sessionOptions?: any;     // pass through to createSession (voice, VAD, etc.)
}) {
  // 1) Get ephemeral token + meta
  const res = await fetch("/api/session", {
    method: "GET",
    credentials: "include",
  });
  const payload = (await res.json()) as EphemeralSessionResponse;

  if (!payload.ok || !payload.client_secret?.value) {
    const msg =
      (payload as any)?.message ||
      "Failed to create ephemeral session (no client_secret)";
    throw new Error(msg);
  }

  // 2) Decide whether to attach calendar tools
  const sid = getSidFromBrowser();
  const shouldAttachCalendar = Boolean(payload.meta?.attachCalendar && sid);

  // 3) Build the Realtime session via your Step 6 helper
  const session = createSession({
    agents: options?.agents ?? CURRENT_SCENARIO_AGENTS,
    sid: shouldAttachCalendar ? sid! : undefined,
    model: options?.model,
    sessionOptions: options?.sessionOptions,
    apiBase:
      options?.apiBase ||
      process.env.NEXT_PUBLIC_MY_HOST ||
      process.env.NEXT_PUBLIC_SERVER_HOST ||
      "",
  });

  // 4) Connect using the ephemeral client secret from /api/session
  await session.connect({ apiKey: payload.client_secret.value });

  // Optional: basic logging hooks (adapt to your Realtime lib)
  try {
    (session as any).on?.("error", (e: unknown) =>
      console.error("[realtime] error", e)
    );
    (session as any).on?.("close", () =>
      console.warn("[realtime] connection closed")
    );
    (session as any).on?.("ready", () =>
      console.log("[realtime] connected ✅")
    );
  } catch {
    // no-op if your wrapper doesn't expose .on
  }

  return { session, meta: payload.meta };
}
