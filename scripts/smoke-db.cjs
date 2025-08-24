// scripts/smoke-db.cjs
// Run with: node scripts/smoke-db.cjs

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Running Prisma smoke test...");

  // Count users
  const count = await prisma.user.count();
  console.log(`✅ User count: ${count}`);

  // Create a demo user if none exist
  if (count === 0) {
    const user = await prisma.user.create({
      data: {
        email: "demo@example.com",
        name: "Demo User",
      },
    });
    console.log("👤 Created demo user:", user);
  } else {
    const users = await prisma.user.findMany({ take: 3 });
    console.log("👥 Found users:", users);
  }

  // Insert an audit log to make sure relations work
  const log = await prisma.auditLog.create({
    data: {
      userId: null,
      action: "SMOKE_TEST",
      metaJson: { time: new Date().toISOString() },
    },
  });
  console.log("📝 Created audit log:", log);

  console.log("🎉 Smoke test completed successfully.");
}

main()
  .catch((e) => {
    console.error("❌ Smoke test failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
