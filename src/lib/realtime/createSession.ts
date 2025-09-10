import { RealtimeAgent, RealtimeSession, tool, type RealtimeSessionOptions } from "@openai/agents/realtime";
import { z } from "zod";

export type CreateSessionOptions = {
  agents: RealtimeAgent[] | Array<ConstructorParameters<typeof RealtimeAgent>[0]>;
  sid?: string | null;
  userId?: string | null;               // Twilio/server
  model?: string;
  sessionOptions?: RealtimeSessionOptions;
  apiBase?: string;
};

export function createSession(opts: CreateSessionOptions): RealtimeSession {
  const {
    agents, sid, userId,
    model = process.env.NEXT_PUBLIC_REALTIME_MODEL || "gpt-4o-realtime-preview",
    sessionOptions, apiBase,
  } = opts;

  const baseUrl =
    apiBase ||
    process.env.NEXT_PUBLIC_MY_HOST ||
    process.env.NEXT_PUBLIC_SERVER_HOST ||
    "";

  // server/browser precedence
  const hasServerUser = !!userId;
  const wantCalendar = hasServerUser || !!sid;

  const normalized: RealtimeAgent[] = (agents as any[]).map((a) => {
    const agent = a instanceof RealtimeAgent ? a : new RealtimeAgent({ ...(a || {}) });

    if (!wantCalendar) return agent;

    const ctx = { baseUrl, sid: sid || "", userId: userId || undefined };

    const tools = [
      calendarListEventsTool(ctx),
      calendarCreateEventTool(ctx),
      calendarFreebusyTool(ctx),
    ];

    return new RealtimeAgent({
      ...(agent as any).getConfiguration?.(),
      name: (agent as any).name,
      instructions: (agent as any).instructions,
      handoffs: (agent as any).handoffs,
      tools: [ ...((agent as any).tools || []), ...tools ],
    });
  });

  return new RealtimeSession(normalized, { model, ...sessionOptions });
}

type ToolCtx = { baseUrl: string; sid?: string; userId?: string };

async function callCalendarAPI<T>(
  ctx: ToolCtx,
  path: string,
  method: "GET" | "POST",
  payload?: Record<string, any>
): Promise<T> {
  const url = new URL(`${ctx.baseUrl}${path}`, typeof window !== "undefined" ? window.location.origin : undefined);
  if (method === "GET" && payload) {
    Object.entries(payload).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)));
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      "content-type": "application/json",
      ...(ctx.sid ? { "x-sid": ctx.sid } : {}),
      ...(ctx.userId ? { "x-user-id": ctx.userId } : {}),
    },
    credentials: "include",
    body: method === "POST" ? JSON.stringify(payload || {}) : undefined,
  });
  if (!res.ok) {
    let msg = "Calendar API error";
    try { const j = await res.json(); msg = j?.message || msg; } catch {}
    // Return structured error so model can retry/ask user to reconnect
    return { ok: false, error: msg } as any;
  }
  return (await res.json()) as T;
}

function calendarListEventsTool(ctx: ToolCtx) {
  const Params = z.object({
    timeMin: z.string().datetime().optional(),
    timeMax: z.string().datetime().optional(),
    maxResults: z.number().int().positive().max(2500).optional().default(10),
    q: z.string().optional(),
  });
  return tool<typeof Params>({
    name: "calendar_list_events",
    description: "List upcoming primary-calendar events within an optional time window.",
    parameters: Params,
    async execute(args) {
      return await callCalendarAPI(ctx, "/api/google/calendar/list", "GET", args);
    },
  });
}

function calendarCreateEventTool(ctx: ToolCtx) {
  const Params = z.object({
    summary: z.string().min(1),
    description: z.string().optional(),
    location: z.string().optional(),
    timeZone: z.string().optional(),
    startDateTime: z.string().datetime(),
    endDateTime: z.string().datetime(),
    attendees: z.array(z.string().email()).optional(),
  });
  return tool<typeof Params>({
    name: "calendar_create_event",
    description: "Create a new event on the user's primary Google Calendar.",
    parameters: Params,
    async execute(args) {
      return await callCalendarAPI(ctx, "/api/google/calendar/create", "POST", args);
    },
  });
}

function calendarFreebusyTool(ctx: ToolCtx) {
  const Params = z.object({
    timeMin: z.string().datetime(),
    timeMax: z.string().datetime(),
    timeZone: z.string().optional(),
  });
  return tool<typeof Params>({
    name: "calendar_freebusy",
    description: "Get free/busy info for the user's primary calendar.",
    parameters: Params,
    async execute(args) {
      return await callCalendarAPI(ctx, "/api/google/calendar/freebusy", "POST", args);
    },
  });
}
