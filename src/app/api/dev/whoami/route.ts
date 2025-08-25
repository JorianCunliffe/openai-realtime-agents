import { NextResponse } from "next/server";
export const runtime = "nodejs";
import { getSessionId } from "@/lib/session";

export async function GET() {
  return NextResponse.json({ ok: true, sid: getSessionId() });
}
