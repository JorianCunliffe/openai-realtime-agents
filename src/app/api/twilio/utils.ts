// File: src/app/api/twilio/utils.ts
// Shared helpers for Twilio voice routes

const MEDIA_PATH = "/twilio-media";

/**
 * Public HTTPS origin of your app (e.g., https://<your-app>.example.com).
 * Set MY_HOST in env for consistent construction.
 */
export function getPublicHost(): string {
  const h = process.env.MY_HOST?.trim();
  if (!h) throw new Error("Missing MY_HOST env (e.g., https://your-host)");
  return h.replace(/\/+$/, "");
}

export function httpsToWss(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

export function buildWsUrl(
  userId: string,
  extraQuery: Record<string, string | undefined> = {}
): string {
  const base = httpsToWss(getPublicHost());
  const params = new URLSearchParams({ userId });
  for (const [key, value] of Object.entries(extraQuery)) {
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  return `${base}${MEDIA_PATH}?${params.toString()}`;
}

export { MEDIA_PATH as TWILIO_MEDIA_PATH };
