export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { setSessionId } from "@/lib/session";

const prisma = new PrismaClient();

export async function GET() {
  // make a userId (dev) – use your real user id system if you have one
  const userId = `dev_${randomUUID()}`;

  // create a Session row so /api/auth/google can find it
  const sid = randomUUID();
  await prisma.session.create({ data: { id: sid, userId } });

  // set signed cookie
  await setSessionId(sid);

  return NextResponse.json({ ok: true, sid });
}