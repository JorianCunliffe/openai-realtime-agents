// File: src/app/api/twilio/voice/route.ts
import type { NextRequest } from "next/server";
import { twiml } from "twilio";

const { VoiceResponse } = twiml;

// Optional env to bypass verification for quick end-to-end tests
const VERIFY_DISABLED = process.env.TWILIO_VERIFY_DISABLED === "1";

// ---- Config helpers ----
function getPublicHost(): string {
  // Public HTTPS origin of your app (e.g., https://<your-repl>.replit.app)
  // Set MY_HOST in env for consistent construction.
  const h = process.env.MY_HOST?.trim();
  if (!h) throw new Error("Missing MY_HOST env (e.g., https://your-host)");
  return h.replace(/\/+$/, "");
}

function httpsToWss(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function buildWsUrl(userId: string): string {
  const base = getPublicHost(); // e.g. https://openai-realtime-agents-joriancunliffe.replit.app
  // Single-port: just swap to wss and keep path
  return `${httpsToWss(base)}/twilio-media?userId=${encodeURIComponent(userId)}`;
}


// ---- Very simple caller -> userId mapping (replace with your real source/DB) ----
function resolveUserIdForCaller(e164From: string | null): string {
  // Example mapping. Replace with your CallerMapping source.
  const M: Record<string, string> = {
    "+61412345678": "user_aus_demo",
    "+15555550123": "user_us_demo",
  };
  if (!e164From) return "guest";
  return M[e164From] ?? "guest";
}

// ---- Optional: Twilio signature verification (enabled in production) ----
async function verifyTwilioSignature(req: NextRequest, bodyParams: URLSearchParams): Promise<boolean> {
  if (VERIFY_DISABLED || process.env.NODE_ENV !== "production") return true; // skip in dev or if bypass set
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn("TWILIO_AUTH_TOKEN not set; cannot verify signature. Rejecting in production.");
    return false;
  }
  const signature = req.headers.get("x-twilio-signature") ?? "";
  // Reconstruct the **public** URL Twilio hit (what they signed), not internal nextUrl
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const url = `${proto}://${host}${req.nextUrl.pathname}`;

  // Twilio's helper requires a plain object of params
  const paramsObj: Record<string, string> = {};
  bodyParams.forEach((v, k) => (paramsObj[k] = v));

  // Lazy import to avoid serverless cold path cost when unused
  const { validateRequest } = await import("twilio/lib/webhooks/webhooks.js");
  const ok = validateRequest(authToken, signature, url, paramsObj);
  if (!ok) {
    console.error("[Twilio] Signature validation failed", {
      url, proto, host, path: req.nextUrl.pathname,
      headerPresent: !!signature,
      hasToken: !!authToken,
    });
  }
  return ok;
}

// Twilio sends application/x-www-form-urlencoded
export async function POST(req: NextRequest) {
  // IMPORTANT: read the RAW body to preserve '+' vs '%20' and ordering
  const raw = await req.text();
  const params = new URLSearchParams(raw);

  const ok = await verifyTwilioSignature(req, params);
  if (!ok) {
    return new Response("Signature validation failed", { status: 403 });
  }


  const from = params.get("From");
  const userId = resolveUserIdForCaller(from);

  const wsUrl = buildWsUrl(userId);

  const vr = new VoiceResponse();
  const start = vr.start();
  // You can add <Parameter> tags if you want more data to show up in "start" frame
  // start.parameter({ name: "userId", value: userId });
  start.stream({ url: wsUrl });

  const xml = vr.toString();
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

// Twilio may probe with GET in some setups; return simple doc
export async function GET() {
  return new Response("Twilio Voice webhook ready", { status: 200 });
}
