import { PrismaClient } from "@prisma/client";

// Avoid multiple clients in Next dev (HMR)
declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.prisma ?? new PrismaClient({
    // log: ["query", "error", "warn"], // uncomment if you want logs
  });

if (process.env.NODE_ENV !== "production") globalThis.prisma = prisma;

export default prisma;
