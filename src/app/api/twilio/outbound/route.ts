// File: src/app/api/twilio/outbound/route.ts
import { NextRequest, NextResponse } from "next/server";
import twilio, { type Twilio } from "twilio";
import { twiml } from "twilio";

import { buildWsUrl } from "../utils";

const { VoiceResponse } = twiml;

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
const OUTBOUND_FROM_NUMBER =
  process.env.PHONE_NUMBER_FROM?.trim() ||
  process.env.TWILIO_PHONE_NUMBER?.trim() ||
  "";
const VERIFY_DISABLED = process.env.TWILIO_VERIFY_DISABLED === "1";

let cachedClient: Twilio | null = null;

function getClient(): Twilio {
  if (!cachedClient) {
    if (!ACCOUNT_SID || !AUTH_TOKEN) {
      throw new Error("Missing Twilio credentials. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.");
    }
    cachedClient = twilio(ACCOUNT_SID, AUTH_TOKEN);
  }
  return cachedClient;
}

async function isNumberAllowed(client: Twilio, to: string): Promise<boolean> {
  if (VERIFY_DISABLED) return true;

  try {
    // Uncomment these lines to test numbers. Only add numbers you have permission to call.
    // const consentMap: Record<string, boolean> = { "+18005551212": true };
    // if (consentMap[to]) return true;

    const [incomingNumbers, outgoingCallerIds] = await Promise.all([
      client.incomingPhoneNumbers.list({ phoneNumber: to }),
      client.outgoingCallerIds.list({ phoneNumber: to }),
    ]);

    return incomingNumbers.length > 0 || outgoingCallerIds.length > 0;
  } catch (error) {
    console.error("[Twilio] Error checking phone number", error);
    return false;
  }
}

function buildOutboundTwiml(userId: string): string {
  const wsUrl = buildWsUrl(userId, { direction: "outbound" });
  const response = new VoiceResponse();
  const connect = response.connect();
  connect.stream({ url: wsUrl, track: "outbound_track" });
  return response.toString();
}

export async function POST(req: NextRequest) {
  if (!OUTBOUND_FROM_NUMBER) {
    return NextResponse.json(
      {
        ok: false,
        message: "Missing outbound caller ID. Set PHONE_NUMBER_FROM (or TWILIO_PHONE_NUMBER).",
      },
      { status: 500 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    console.error("[Twilio] Invalid JSON payload for outbound call", error);
    return NextResponse.json({ ok: false, message: "Invalid JSON payload" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const to = typeof payload.to === "string" ? payload.to.trim() : "";
  const userIdInput = typeof payload.userId === "string" ? payload.userId.trim() : "";
  const userId = userIdInput || to || "outbound_guest";

  if (!to) {
    return NextResponse.json({ ok: false, message: "Missing 'to' phone number" }, { status: 400 });
  }

  let client: Twilio;
  try {
    client = getClient();
  } catch (error: any) {
    console.error("[Twilio] Unable to initialize client", error);
    return NextResponse.json(
      { ok: false, message: error?.message ?? "Missing Twilio credentials" },
      { status: 500 }
    );
  }

  const isAllowed = await isNumberAllowed(client, to);
  if (!isAllowed) {
    return NextResponse.json(
      {
        ok: false,
        message: `The number ${to} is not recognized as a verified Twilio number or caller ID.`,
      },
      { status: 403 }
    );
  }

  try {
    const call = await client.calls.create({
      to,
      from: OUTBOUND_FROM_NUMBER,
      twiml: buildOutboundTwiml(userId),
    });

    return NextResponse.json({
      ok: true,
      callSid: call.sid,
      to,
      from: OUTBOUND_FROM_NUMBER,
    });
  } catch (error: any) {
    console.error("[Twilio] Error making outbound call", error);
    return NextResponse.json(
      { ok: false, message: error?.message ?? "Failed to initiate outbound call" },
      { status: 500 }
    );
  }
}
