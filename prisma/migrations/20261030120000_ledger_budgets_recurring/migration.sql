-- Hand-edited so that existing data is converted, not lost:
--   * Float rupee amounts become integer paise (ROUND(amount * 100)).
--   * Splits that were marked paid become CONFIRMED Settlement rows.
--   * Duplicate (expense, user) split rows are merged before the unique index.
--   * Every expense gets an explicit split row for the payer's own share.

-- CreateEnum
CREATE TYPE "SplitType" AS ENUM ('EQUAL', 'EXACT', 'PERCENTAGE', 'SHARES', 'ITEMIZED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "Frequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

-- DropForeignKey
ALTER TABLE "Friendship" DROP CONSTRAINT "Friendship_addresseeId_fkey";

-- DropForeignKey
ALTER TABLE "Friendship" DROP CONSTRAINT "Friendship_requesterId_fkey";

-- DropForeignKey
ALTER TABLE "GroupMember" DROP CONSTRAINT "GroupMember_groupId_fkey";

-- DropForeignKey
ALTER TABLE "GroupMember" DROP CONSTRAINT "GroupMember_userId_fkey";

-- DropForeignKey
ALTER TABLE "ExpenseSplit" DROP CONSTRAINT "ExpenseSplit_expenseId_fkey";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "defaultCurrency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable: rupees (float) -> paise (integer)
ALTER TABLE "Expense" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "recurringExpenseId" TEXT,
ADD COLUMN     "splitType" "SplitType" NOT NULL DEFAULT 'EQUAL',
ALTER COLUMN "amount" SET DATA TYPE INTEGER USING ROUND("amount" * 100)::INTEGER;

ALTER TABLE "ExpenseSplit" ALTER COLUMN "amount" SET DATA TYPE INTEGER USING ROUND("amount" * 100)::INTEGER;

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "payeeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "groupId" TEXT,
    "note" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "recordedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- Data: paid splits -> confirmed settlements
INSERT INTO "Settlement" ("id", "payerId", "payeeId", "amount", "currency", "groupId", "note", "status", "recordedById", "confirmedAt", "createdAt")
SELECT gen_random_uuid()::text, s."userId", e."payerId", s."amount", e."currency", e."groupId",
       'Migrated from settled split', 'CONFIRMED', e."payerId",
       COALESCE(s."settledAt", s."createdAt"), COALESCE(s."settledAt", s."createdAt")
FROM "ExpenseSplit" s
JOIN "Expense" e ON e."id" = s."expenseId"
WHERE s."paid" = true AND s."userId" <> e."payerId";

-- AlterTable
ALTER TABLE "ExpenseSplit" DROP COLUMN "paid",
DROP COLUMN "settledAt";

-- Data: merge duplicate split rows for the same expense and user
UPDATE "ExpenseSplit" s
SET "amount" = d."total"
FROM (
  SELECT "expenseId", "userId", MIN("id") AS "keepId", SUM("amount") AS "total"
  FROM "ExpenseSplit"
  GROUP BY "expenseId", "userId"
  HAVING COUNT(*) > 1
) d
WHERE s."id" = d."keepId";

DELETE FROM "ExpenseSplit" s
USING (
  SELECT "expenseId", "userId", MIN("id") AS "keepId"
  FROM "ExpenseSplit"
  GROUP BY "expenseId", "userId"
  HAVING COUNT(*) > 1
) d
WHERE s."expenseId" = d."expenseId" AND s."userId" = d."userId" AND s."id" <> d."keepId";

-- Data: the payer's own share is whatever is left after everyone else's share
DELETE FROM "ExpenseSplit" s
USING "Expense" e
WHERE s."expenseId" = e."id" AND s."userId" = e."payerId";

INSERT INTO "ExpenseSplit" ("id", "expenseId", "userId", "amount", "createdAt")
SELECT gen_random_uuid()::text, e."id", e."payerId", e."amount" - COALESCE(o."othersTotal", 0), e."createdAt"
FROM "Expense" e
LEFT JOIN (
  SELECT "expenseId", SUM("amount") AS "othersTotal"
  FROM "ExpenseSplit"
  GROUP BY "expenseId"
) o ON o."expenseId" = e."id"
WHERE e."amount" - COALESCE(o."othersTotal", 0) > 0;

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "period" "BudgetPeriod" NOT NULL DEFAULT 'MONTHLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringExpense" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "category" TEXT NOT NULL,
    "description" TEXT,
    "frequency" "Frequency" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "nextDate" TIMESTAMP(3) NOT NULL,
    "occurrencesCreated" INTEGER NOT NULL DEFAULT 0,
    "groupId" TEXT,
    "splitWith" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Settlement_payerId_idx" ON "Settlement"("payerId");

-- CreateIndex
CREATE INDEX "Settlement_payeeId_idx" ON "Settlement"("payeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_userId_category_period_currency_key" ON "Budget"("userId", "category", "period", "currency");

-- CreateIndex
CREATE INDEX "RecurringExpense_ownerId_active_nextDate_idx" ON "RecurringExpense"("ownerId", "active", "nextDate");

-- CreateIndex
CREATE INDEX "Friendship_addresseeId_idx" ON "Friendship"("addresseeId");

-- CreateIndex
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- CreateIndex
CREATE INDEX "Expense_payerId_date_idx" ON "Expense"("payerId", "date");

-- CreateIndex
CREATE INDEX "Expense_groupId_idx" ON "Expense"("groupId");

-- CreateIndex
CREATE INDEX "Expense_category_idx" ON "Expense"("category");

-- CreateIndex
CREATE INDEX "ExpenseSplit_userId_idx" ON "ExpenseSplit"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseSplit_expenseId_userId_key" ON "ExpenseSplit"("expenseId", "userId");

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_recurringExpenseId_fkey" FOREIGN KEY ("recurringExpenseId") REFERENCES "RecurringExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseSplit" ADD CONSTRAINT "ExpenseSplit_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpense" ADD CONSTRAINT "RecurringExpense_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
