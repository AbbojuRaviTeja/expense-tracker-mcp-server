import { prisma } from "../../db";

export const hasDb = Boolean(process.env.TEST_DATABASE_URL);

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "ExpenseSplit", "Expense", "Settlement", "Budget", "RecurringExpense", "GroupMember", "Group", "Friendship", "User" CASCADE`,
  );
}

export async function makeUser(name: string, timezone = "Asia/Kolkata") {
  return prisma.user.create({
    data: {
      email: `${name.toLowerCase()}@test.dev`,
      name,
      googleId: `google-${name}`,
      status: "ACTIVE",
      timezone,
      defaultCurrency: "INR",
    },
  });
}

export { prisma };
