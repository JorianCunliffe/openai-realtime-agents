import { NextResponse } from "next/server";
import { prisma } from "@/lib/db"; // uses your @/ alias

export async function GET() {
  try {
    const ping = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 as ok`;
    return NextResponse.json({ ok: true, ping: ping[0]?.ok === 1 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}