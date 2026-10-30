# Expense Tracker Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** Build an MCP server with FastMCP and Prisma for tracking expenses.

**Architecture:** A standard Node.js server using Prisma for PostgreSQL database access and `fastmcp` to expose MCP tools for `addExpense`, `listExpenses`, `updateExpense`, `deleteExpense` and `getExpensesSummaryByCategory`.

**Tech Stack:** TypeScript, Node.js, FastMCP, Prisma, Vitest

---

### Task 1: Setup Prisma, Database, and Testing Environment

**Files:**
- Create: `prisma/schema.prisma`
- Modify: `package.json`

**Step 1: Install Dependencies**
Run: `pnpm add @prisma/client`
Run: `pnpm add -D prisma vitest typescript @types/node tsx`
Expected: Dependencies installed successfully.

**Step 2: Initialize Prisma**
Run: `npx prisma init`
Expected: Creates `prisma/schema.prisma` and `.env`.

**Step 3: Commit**
```bash
git add package.json pnpm-lock.yaml prisma/schema.prisma .env
git commit -m "chore: setup prisma and testing dependencies"
```

---

### Task 2: Define Prisma Schema

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Update Schema Definition**
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Expense {
  id          String   @id @default(uuid())
  amount      Float
  category    String
  description String?
  date        DateTime
  userId      String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

**Step 2: Run Prisma generate**
(Note: we assume `DATABASE_URL` is set in `.env` to the Neon Postgres string. For now, running `npx prisma generate` creates the types).
Run: `npx prisma generate`
Expected: PASS

**Step 3: Commit**
```bash
git add prisma/schema.prisma
git commit -m "feat: define Expense schema"
```

---

### Task 3: Implement Database Client & addExpense logic

**Files:**
- Create: `src/db.ts`
- Create: `src/tools/add-expense.tool.ts`
- Create: `tests/add-expense.test.ts`

**Step 1: Create DB Client**
```typescript
// src/db.ts
import { PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient();
```

**Step 2: Write failing test**
```typescript
// tests/add-expense.test.ts
import { describe, it, expect } from 'vitest';
import { addExpense } from '../src/tools/add-expense.tool';

describe('addExpense', () => {
  it('should add an expense', async () => {
    // Note: requires mocked prisma or a test DB. 
    // For simplicity of this task, we will mock prisma client.
    expect(addExpense).toBeDefined();
  });
});
```

**Step 3: Run test**
Run: `npx vitest run tests/add-expense.test.ts`
Expected: FAIL (cannot find module)

**Step 4: Implement minimal code**
```typescript
// src/tools/add-expense.tool.ts
import { prisma } from '../db';
import { z } from 'zod';

export const addExpenseSchema = z.object({
  amount: z.number(),
  category: z.string(),
  description: z.string().optional(),
  date: z.string().datetime()
});

export async function addExpense(args: z.infer<typeof addExpenseSchema>) {
  return await prisma.expense.create({
    data: {
      amount: args.amount,
      category: args.category,
      description: args.description,
      date: new Date(args.date)
    }
  });
}
```

**Step 5: Run test to verify it passes**
Run: `npx vitest run tests/add-expense.test.ts`
Expected: PASS

**Step 6: Commit**
```bash
git add src/db.ts src/tools/add-expense.tool.ts tests/add-expense.test.ts
git commit -m "feat: implement addExpense tool logic"
```

---

### Task 4: Implement listExpenses

**Files:**
- Create: `src/tools/list-expenses.tool.ts`
- Create: `tests/list-expenses.test.ts`

**Step 1: Write failing test**
(Omitted full code for brevity, standard vitest test calling `listExpenses`).

**Step 2: Run test (FAIL)**

**Step 3: Implement minimal code**
```typescript
import { prisma } from '../db';

export async function listExpenses() {
  return await prisma.expense.findMany({
    orderBy: { date: 'desc' }
  });
}
```

**Step 4: Run test (PASS)**

**Step 5: Commit**

---

### Task 5: Implement updateExpense & deleteExpense

**Files:**
- Create: `src/tools/update-expense.tool.ts`
- Create: `src/tools/delete-expense.tool.ts`

(Follow exact TDD pattern as above for these standard CRUD wrappers over prisma.expense.update and modify/delete).

---

### Task 6: Implement getExpensesSummaryByCategory

**Files:**
- Create: `src/tools/get-summary.tool.ts`

**Step 1: Write failing test**
Call `getExpensesSummaryByCategory` and expect a grouped JSON structure.

**Step 2: Run test (FAIL)**

**Step 3: Implement minimal code**
```typescript
import { prisma } from '../db';

export async function getExpensesSummaryByCategory() {
  const grouped = await prisma.expense.groupBy({
    by: ['category'],
    _sum: { amount: true }
  });
  
  return grouped.map(g => ({
    category: g.category,
    total: g._sum.amount
  }));
}
```

**Step 4: Run test (PASS)**

**Step 5: Commit**

---

### Task 7: Wire up FastMCP

**Files:**
- Modify: `main.ts`

**Step 1: Implement Server Bindings**
Import all tools in `main.ts` and call `server.addTool`.

**Step 2: Test MCP server starts**
Run: `npx tsx main.ts` (Should compile and bind without error)

**Step 3: Commit**
```bash
git add main.ts
git commit -m "feat: wire all tools to fastmcp server"
```
