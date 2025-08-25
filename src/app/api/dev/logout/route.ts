import { NextResponse } from "next/server";
export const runtime = "nodejs";
import { clearSession } from "@/lib/session";

export async function GET() {
  clearSession();
  return NextResponse.json({ ok: true });
}
