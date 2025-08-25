import { NextResponse } from "next/server";
export const runtime = "nodejs";
import { newSessionId, setSessionId } from "@/lib/session";

export async function GET() {
  const sid = newSessionId();
  setSessionId(sid);
  return NextResponse.json({ ok: true, sid });
}
