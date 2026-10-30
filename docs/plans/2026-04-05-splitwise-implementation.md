# Splitwise Multi-User Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** Add multi-user support with Google OAuth, friend management, groups, and expense splitting to the existing MCP server.

**Architecture:** Switch transport from `stdio` to `httpStream`, add `GoogleProvider` for auth, expand Prisma schema with `User`, `Friendship`, `Group`, `GroupMember`, and `ExpenseSplit` models, and implement 8 new tools + update 5 existing ones. A shared `resolveUser` helper upserts the current Google user on every authenticated tool call. A shared `resolveDateRange` utility handles all date filtering.

**Tech Stack:** TypeScript, FastMCP (httpStream + GoogleProvider), Prisma 7, Neon PostgreSQL, Zod, Vitest

**Design doc:** `docs/plans/2026-04-05-splitwise-design.md`

---

### Task 1: Update Prisma Schema

**Files:**
- Modify: `prisma/schema.prisma`

**Step 1: Replace the entire schema content**

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

enum UserStatus {
  ACTIVE
  INVITED
}

enum FriendshipStatus {
  PENDING
  ACCEPTED
}

model User {
  id        String     @id @default(uuid())
  googleId  String?    @unique
  email     String     @unique
  name      String?
  status    UserStatus @default(INVITED)
  createdAt DateTime   @default(now())

  expenses            Expense[]      @relation("Payer")
  splits              ExpenseSplit[]
  sentFriendships     Friendship[]   @relation("Requester")
  receivedFriendships Friendship[]   @relation("Addressee")
  groupMemberships    GroupMember[]
  createdGroups       Group[]
}

model Friendship {
  id          String           @id @default(uuid())
  requesterId String
  addresseeId String
  status      FriendshipStatus @default(ACCEPTED)
  createdAt   DateTime         @default(now())

  requester User @relation("Requester", fields: [requesterId], references: [id])
  addressee User @relation("Addressee", fields: [addresseeId], references: [id])

  @@unique([requesterId, addresseeId])
}

model Group {
  id          String   @id @default(uuid())
  name        String
  createdById String
  createdAt   DateTime @default(now())

  createdBy Group       @relation(fields: [createdById], references: [id])
  members   GroupMember[]
  expenses  Expense[]
}

model GroupMember {
  groupId String
  userId  String

  group Group @relation(fields: [groupId], references: [id])
  user  User  @relation(fields: [userId], references: [id])

  @@id([groupId, userId])
}

model Expense {
  id          String   @id @default(uuid())
  amount      Float
  category    String
  description String?
  date        DateTime
  payerId     String
  groupId     String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  payer  User           @relation("Payer", fields: [payerId], references: [id])
  group  Group?         @relation(fields: [groupId], references: [id])
  splits ExpenseSplit[]
}

model ExpenseSplit {
  id        String    @id @default(uuid())
  expenseId String
  userId    String
  amount    Float
  paid      Boolean   @default(false)
  settledAt DateTime?
  createdAt DateTime  @default(now())

  expense Expense @relation(fields: [expenseId], references: [id])
  user    User    @relation(fields: [userId], references: [id])
}
```

**Step 2: Fix the Group self-relation error**

The `Group.createdBy` relation should reference `User`, not `Group`. The correct field:
```prisma
  createdBy User        @relation(fields: [createdById], references: [id])
```

**Step 3: Generate Prisma Client**

Run: `pnpm run db:generate`
Expected: `✔ Generated Prisma Client`

**Step 4: Push schema to database**

Run: `pnpm run db:push`
Expected: `Your database is now in sync with your Prisma schema.`

**Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: expand schema with User, Friendship, Group, GroupMember, ExpenseSplit"
```

---

### Task 2: Add Shared Utilities

**Files:**
- Create: `lib/resolve-date-range.ts`
- Create: `lib/resolve-user.ts`
- Create: `lib/index.ts`

**Step 1: Create `lib/resolve-date-range.ts`**

```typescript
export type Period = "this_week" | "last_week" | "this_month" | "last_month" | "this_year";

export function resolveDateRange(
  period?: Period,
  startDate?: string,
  endDate?: string
): { gte?: Date; lte?: Date } {
  if (startDate || endDate) {
    return {
      gte: startDate ? new Date(startDate) : undefined,
      lte: endDate ? new Date(endDate) : undefined,
    };
  }

  if (!period) return {};

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  switch (period) {
    case "this_week": {
      const day = now.getUTCDay();
      const monday = new Date(Date.UTC(year, month, now.getUTCDate() - day + 1));
      const sunday = new Date(Date.UTC(year, month, now.getUTCDate() - day + 7, 23, 59, 59, 999));
      return { gte: monday, lte: sunday };
    }
    case "last_week": {
      const day = now.getUTCDay();
      const lastMonday = new Date(Date.UTC(year, month, now.getUTCDate() - day - 6));
      const lastSunday = new Date(Date.UTC(year, month, now.getUTCDate() - day, 23, 59, 59, 999));
      return { gte: lastMonday, lte: lastSunday };
    }
    case "this_month":
      return {
        gte: new Date(Date.UTC(year, month, 1)),
        lte: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
      };
    case "last_month":
      return {
        gte: new Date(Date.UTC(year, month - 1, 1)),
        lte: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
      };
    case "this_year":
      return {
        gte: new Date(Date.UTC(year, 0, 1)),
        lte: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
      };
    default:
      return {};
  }
}
```

**Step 2: Write test for `resolve-date-range`**

Create: `tests/lib/resolve-date-range.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveDateRange } from "../../lib/resolve-date-range";

describe("resolveDateRange", () => {
  it("returns empty object when no params given", () => {
    expect(resolveDateRange()).toEqual({});
  });

  it("prefers explicit startDate/endDate over period", () => {
    const result = resolveDateRange("this_month", "2026-01-01T00:00:00Z", "2026-01-31T23:59:59Z");
    expect(result.gte).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(result.lte).toEqual(new Date("2026-01-31T23:59:59Z"));
  });

  it("resolves this_month correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
    const result = resolveDateRange("this_month");
    expect(result.gte).toEqual(new Date("2026-04-01T00:00:00.000Z"));
    expect(result.lte).toEqual(new Date("2026-04-30T23:59:59.999Z"));
    vi.useRealTimers();
  });

  it("resolves last_month correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
    const result = resolveDateRange("last_month");
    expect(result.gte).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(result.lte).toEqual(new Date("2026-03-31T23:59:59.999Z"));
    vi.useRealTimers();
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run tests/lib/resolve-date-range.test.ts`
Expected: `4 passed`

**Step 4: Create `lib/resolve-user.ts`**

```typescript
import { prisma } from "../db";

interface GoogleSession {
  googleId: string;
  email: string;
  name?: string;
}

export async function resolveUser(session: GoogleSession) {
  // Try to find existing active user by googleId first
  const existingByGoogleId = await prisma.user.findUnique({
    where: { googleId: session.googleId },
  });
  if (existingByGoogleId) return existingByGoogleId;

  // Upsert: activate an INVITED placeholder or create new user
  return await prisma.user.upsert({
    where: { email: session.email },
    update: {
      googleId: session.googleId,
      name: session.name,
      status: "ACTIVE",
    },
    create: {
      googleId: session.googleId,
      email: session.email,
      name: session.name,
      status: "ACTIVE",
    },
  });
}
```

**Step 5: Create `lib/index.ts`**

```typescript
export { resolveDateRange } from "./resolve-date-range";
export type { Period } from "./resolve-date-range";
export { resolveUser } from "./resolve-user";
```

**Step 6: Commit**

```bash
git add lib/
git commit -m "feat: add resolveUser and resolveDateRange shared utilities"
```

---

### Task 3: Implement Friends Tools

**Files:**
- Create: `types/add-friend.type.ts`
- Create: `tools/add-friend.tool.ts`
- Create: `tools/list-friends.tool.ts`
- Create: `tests/add-friend.test.ts`
- Create: `tests/list-friends.test.ts`

**Step 1: Create `types/add-friend.type.ts`**

```typescript
import { z } from "zod";

export const addFriendSchema = z.object({
  email: z.string().email(),
});
```

**Step 2: Create `tools/add-friend.tool.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../db";
import { addFriendSchema } from "../types";

export async function addFriend(
  args: z.infer<typeof addFriendSchema>,
  currentUserId: string
) {
  const { email } = args;

  if (email === (await prisma.user.findUnique({ where: { id: currentUserId } }))?.email) {
    throw new Error("You cannot add yourself as a friend.");
  }

  // Find or create placeholder for friend
  const friend = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, status: "INVITED" },
  });

  // Check if friendship already exists
  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: currentUserId, addresseeId: friend.id },
        { requesterId: friend.id, addresseeId: currentUserId },
      ],
    },
  });

  if (existing) {
    return { message: "Already friends.", friend };
  }

  const friendship = await prisma.friendship.create({
    data: { requesterId: currentUserId, addresseeId: friend.id },
    include: { addressee: true },
  });

  return {
    message: friend.status === "INVITED"
      ? `Invitation sent to ${email}. They'll see your splits when they join.`
      : `${friend.name ?? email} added as a friend.`,
    friend: friendship.addressee,
  };
}
```

**Step 3: Create `tools/list-friends.tool.ts`**

```typescript
import { prisma } from "../db";

export async function listFriends(currentUserId: string) {
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { requesterId: currentUserId },
        { addresseeId: currentUserId },
      ],
    },
    include: {
      requester: true,
      addressee: true,
    },
  });

  return friendships.map((f) => {
    const friend = f.requesterId === currentUserId ? f.addressee : f.requester;
    return { id: friend.id, name: friend.name, email: friend.email, status: friend.status };
  });
}
```

**Step 4: Write tests**

Create: `tests/add-friend.test.ts`
```typescript
import { describe, it, expect, vi } from "vitest";
import { addFriend } from "../tools/add-friend.tool";
import { prisma } from "../db";

vi.mock("../db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    friendship: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

describe("addFriend", () => {
  it("creates a friendship and INVITED placeholder when friend not found", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "u1", email: "me@test.com" } as any);
    vi.mocked(prisma.user.upsert).mockResolvedValue({ id: "u2", email: "friend@test.com", status: "INVITED" } as any);
    vi.mocked(prisma.friendship.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.friendship.create).mockResolvedValue({
      addressee: { id: "u2", email: "friend@test.com", name: null, status: "INVITED" },
    } as any);

    const result = await addFriend({ email: "friend@test.com" }, "u1");
    expect(result.message).toContain("Invitation sent");
    expect(prisma.friendship.create).toHaveBeenCalled();
  });
});
```

Create: `tests/list-friends.test.ts`
```typescript
import { describe, it, expect, vi } from "vitest";
import { listFriends } from "../tools/list-friends.tool";
import { prisma } from "../db";

vi.mock("../db", () => ({
  prisma: {
    friendship: { findMany: vi.fn() },
  },
}));

describe("listFriends", () => {
  it("returns friends of the current user", async () => {
    vi.mocked(prisma.friendship.findMany).mockResolvedValue([
      {
        requesterId: "u1",
        addresseeId: "u2",
        requester: { id: "u1", name: "Me", email: "me@test.com", status: "ACTIVE" },
        addressee: { id: "u2", name: "Aftab", email: "aftab@test.com", status: "ACTIVE" },
      },
    ] as any);

    const result = await listFriends("u1");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Aftab");
  });
});
```

**Step 5: Run tests**

Run: `npx vitest run tests/add-friend.test.ts tests/list-friends.test.ts`
Expected: `2 passed`

**Step 6: Update exports**

Add to `types/index.ts`:
```typescript
export { addFriendSchema } from "./add-friend.type";
```

Add to `tools/index.ts`:
```typescript
export { addFriend } from "./add-friend.tool";
export { listFriends } from "./list-friends.tool";
```

**Step 7: Commit**

```bash
git add types/add-friend.type.ts tools/add-friend.tool.ts tools/list-friends.tool.ts tests/add-friend.test.ts tests/list-friends.test.ts types/index.ts tools/index.ts
git commit -m "feat: implement add-friend and list-friends tools"
```

---

### Task 4: Implement Groups Tools

**Files:**
- Create: `types/create-group.type.ts`
- Create: `types/add-group-member.type.ts`
- Create: `tools/create-group.tool.ts`
- Create: `tools/list-groups.tool.ts`
- Create: `tools/add-group-member.tool.ts`
- Create: `tests/create-group.test.ts`

**Step 1: Create `types/create-group.type.ts`**

```typescript
import { z } from "zod";

export const createGroupSchema = z.object({
  name: z.string().min(1),
  memberEmails: z.array(z.string().email()).min(1),
});

export const addGroupMemberSchema = z.object({
  groupId: z.string(),
  email: z.string().email(),
});
```

**Step 2: Create `tools/create-group.tool.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../db";
import { createGroupSchema } from "../types";

export async function createGroup(
  args: z.infer<typeof createGroupSchema>,
  currentUserId: string
) {
  const { name, memberEmails } = args;

  // Upsert all member users (create INVITED placeholders if needed)
  const members = await Promise.all(
    memberEmails.map((email) =>
      prisma.user.upsert({
        where: { email },
        update: {},
        create: { email, status: "INVITED" },
      })
    )
  );

  const group = await prisma.group.create({
    data: {
      name,
      createdById: currentUserId,
      members: {
        create: [
          { userId: currentUserId },
          ...members.map((m) => ({ userId: m.id })),
        ],
      },
    },
    include: { members: { include: { user: true } } },
  });

  return group;
}
```

**Step 3: Create `tools/list-groups.tool.ts`**

```typescript
import { prisma } from "../db";

export async function listGroups(currentUserId: string) {
  return await prisma.group.findMany({
    where: {
      members: { some: { userId: currentUserId } },
    },
    include: {
      members: { include: { user: { select: { id: true, name: true, email: true } } } },
    },
  });
}
```

**Step 4: Create `tools/add-group-member.tool.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../db";
import { addGroupMemberSchema } from "../types";

export async function addGroupMember(
  args: z.infer<typeof addGroupMemberSchema>,
  currentUserId: string
) {
  const { groupId, email } = args;

  // Verify requester is in the group
  const membership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: currentUserId } },
  });
  if (!membership) throw new Error("You are not a member of this group.");

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, status: "INVITED" },
  });

  return await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId, userId: user.id } },
    update: {},
    create: { groupId, userId: user.id },
  });
}
```

**Step 5: Write test for create-group**

Create: `tests/create-group.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { createGroup } from "../tools/create-group.tool";
import { prisma } from "../db";

vi.mock("../db", () => ({
  prisma: {
    user: { upsert: vi.fn() },
    group: { create: vi.fn() },
  },
}));

describe("createGroup", () => {
  it("creates a group with members", async () => {
    vi.mocked(prisma.user.upsert).mockResolvedValue({ id: "u2", email: "aftab@test.com" } as any);
    vi.mocked(prisma.group.create).mockResolvedValue({
      id: "g1",
      name: "Goa Trip",
      createdById: "u1",
    } as any);

    const result = await createGroup({ name: "Goa Trip", memberEmails: ["aftab@test.com"] }, "u1");
    expect(prisma.group.create).toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});
```

**Step 6: Run tests**

Run: `npx vitest run tests/create-group.test.ts`
Expected: `1 passed`

**Step 7: Update exports**

Add to `types/index.ts`:
```typescript
export { createGroupSchema, addGroupMemberSchema } from "./create-group.type";
```

Add to `tools/index.ts`:
```typescript
export { createGroup } from "./create-group.tool";
export { listGroups } from "./list-groups.tool";
export { addGroupMember } from "./add-group-member.tool";
```

**Step 8: Commit**

```bash
git add types/ tools/create-group.tool.ts tools/list-groups.tool.ts tools/add-group-member.tool.ts tests/create-group.test.ts
git commit -m "feat: implement create-group, list-groups, add-group-member tools"
```

---

### Task 5: Update add-expense & Implement ExpenseSplit

**Files:**
- Modify: `types/add-expense.type.ts`
- Modify: `tools/add-expense.tool.ts`
- Modify: `tests/add-expense.test.ts`
- Create: `tools/get-split-history.tool.ts`
- Create: `tools/settle-split.tool.ts`
- Create: `tests/get-split-history.test.ts`
- Create: `tests/settle-split.test.ts`

**Step 1: Update `types/add-expense.type.ts`**

```typescript
import { z } from "zod";

export const addExpenseSchema = z.object({
  amount: z.number().positive(),
  category: z.string(),
  description: z.string().optional(),
  date: z.string().datetime(),
  splitWith: z.array(z.string().email()).optional(),
  groupId: z.string().optional(),
});
```

**Step 2: Update `tools/add-expense.tool.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../db";
import { addExpenseSchema } from "../types";

export async function addExpense(
  args: z.infer<typeof addExpenseSchema>,
  currentUserId: string
) {
  const { amount, category, description, date, splitWith, groupId } = args;

  // Resolve split participants
  const splitUsers = splitWith && splitWith.length > 0
    ? await Promise.all(
        splitWith.map((email) =>
          prisma.user.upsert({
            where: { email },
            update: {},
            create: { email, status: "INVITED" },
          })
        )
      )
    : [];

  const splitCount = splitUsers.length + 1; // +1 for payer
  const shareAmount = splitCount > 1 ? parseFloat((amount / splitCount).toFixed(2)) : 0;

  const expense = await prisma.expense.create({
    data: {
      amount,
      category,
      description,
      date: new Date(date),
      payerId: currentUserId,
      groupId,
      splits: splitUsers.length > 0
        ? {
            create: splitUsers.map((u) => ({
              userId: u.id,
              amount: shareAmount,
            })),
          }
        : undefined,
    },
    include: { splits: { include: { user: true } } },
  });

  return expense;
}
```

**Step 3: Create `tools/get-split-history.tool.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../db";

export const getSplitHistorySchema = z.object({
  friendEmail: z.string().email().optional(),
  paid: z.boolean().optional(),
});

export async function getSplitHistory(
  args: z.infer<typeof getSplitHistorySchema>,
  currentUserId: string
) {
  const { friendEmail, paid } = args;

  const friendFilter = friendEmail
    ? { user: { email: friendEmail } }
    : {};

  // Splits where the current user is owed (they are the payer of the expense)
  const owedToMe = await prisma.expenseSplit.findMany({
    where: {
      expense: { payerId: currentUserId },
      paid: paid,
      ...friendFilter,
    },
    include: { expense: true, user: true },
  });

  // Splits where the current user owes someone else
  const iOwe = await prisma.expenseSplit.findMany({
    where: {
      userId: currentUserId,
      paid: paid,
      ...(friendEmail ? { expense: { payer: { email: friendEmail } } } : {}),
    },
    include: { expense: { include: { payer: true } }, user: true },
  });

  return { owedToMe, iOwe };
}
```

**Step 4: Create `tools/settle-split.tool.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../db";

export const settleSplitSchema = z.object({
  friendEmail: z.string().email(),
  splitId: z.string().optional(), // if provided, settle directly; if not, return list
});

export async function settleUp(
  args: z.infer<typeof settleSplitSchema>,
  currentUserId: string
) {
  const { friendEmail, splitId } = args;

  const friend = await prisma.user.findUnique({ where: { email: friendEmail } });
  if (!friend) throw new Error(`No user found with email ${friendEmail}`);

  // If splitId provided, settle directly
  if (splitId) {
    return await prisma.expenseSplit.update({
      where: { id: splitId },
      data: { paid: true, settledAt: new Date() },
      include: { expense: true, user: true },
    });
  }

  // Find open splits between these two users
  const openSplits = await prisma.expenseSplit.findMany({
    where: {
      OR: [
        { userId: friend.id, expense: { payerId: currentUserId }, paid: false },
        { userId: currentUserId, expense: { payerId: friend.id }, paid: false },
      ],
    },
    include: { expense: true, user: true },
  });

  if (openSplits.length === 0) {
    return { message: `No open splits found with ${friendEmail}.` };
  }

  if (openSplits.length === 1) {
    // Auto-settle if only one
    return await prisma.expenseSplit.update({
      where: { id: openSplits[0].id },
      data: { paid: true, settledAt: new Date() },
      include: { expense: true, user: true },
    });
  }

  // Return list for user to pick
  return {
    message: `Multiple open splits found with ${friend.name ?? friendEmail}. Please specify a splitId.`,
    openSplits,
  };
}
```

**Step 5: Write tests**

Create: `tests/get-split-history.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { getSplitHistory } from "../tools/get-split-history.tool";
import { prisma } from "../db";

vi.mock("../db", () => ({
  prisma: {
    expenseSplit: { findMany: vi.fn() },
  },
}));

describe("getSplitHistory", () => {
  it("returns owedToMe and iOwe splits", async () => {
    vi.mocked(prisma.expenseSplit.findMany).mockResolvedValue([]);
    const result = await getSplitHistory({}, "u1");
    expect(result).toHaveProperty("owedToMe");
    expect(result).toHaveProperty("iOwe");
  });
});
```

Create: `tests/settle-split.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { settleUp } from "../tools/settle-split.tool";
import { prisma } from "../db";

vi.mock("../db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    expenseSplit: { findMany: vi.fn(), update: vi.fn() },
  },
}));

describe("settleUp", () => {
  it("returns message when no open splits", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "u2", email: "aftab@test.com" } as any);
    vi.mocked(prisma.expenseSplit.findMany).mockResolvedValue([]);
    const result = await settleUp({ friendEmail: "aftab@test.com" }, "u1");
    expect((result as any).message).toContain("No open splits");
  });

  it("settles directly when splitId provided", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "u2", email: "aftab@test.com" } as any);
    vi.mocked(prisma.expenseSplit.update).mockResolvedValue({ id: "s1", paid: true } as any);
    const result = await settleUp({ friendEmail: "aftab@test.com", splitId: "s1" }, "u1");
    expect((result as any).paid).toBe(true);
  });
});
```

**Step 6: Run all tests**

Run: `npx vitest run tests/add-expense.test.ts tests/get-split-history.test.ts tests/settle-split.test.ts`
Expected: `PASS`

**Step 7: Update exports**

Add to `tools/index.ts`:
```typescript
export { getSplitHistory, getSplitHistorySchema } from "./get-split-history.tool";
export { settleUp, settleSplitSchema } from "./settle-split.tool";
```

**Step 8: Commit**

```bash
git add types/add-expense.type.ts tools/add-expense.tool.ts tools/get-split-history.tool.ts tools/settle-split.tool.ts tests/
git commit -m "feat: update add-expense with splits, add get-split-history and settle-split tools"
```

---

### Task 6: Update Summary Tools & Add get-expenses-by-category

**Files:**
- Modify: `tools/get-summary.tool.ts`
- Modify: `types/get-summary.type.ts`
- Create: `tools/get-expenses-by-category.tool.ts`
- Create: `types/get-expenses-by-category.type.ts`
- Modify: `tests/get-summary.test.ts`
- Create: `tests/get-expenses-by-category.test.ts`

**Step 1: Update `types/get-summary.type.ts`**

```typescript
import { z } from "zod";

export const getSummarySchema = z.object({
  period: z.enum(["this_week", "last_week", "this_month", "last_month", "this_year"]).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});
```

**Step 2: Update `tools/get-summary.tool.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../db";
import { getSummarySchema } from "../types";
import { resolveDateRange } from "../lib";

export async function getSummary(
  args: z.infer<typeof getSummarySchema>,
  currentUserId: string
) {
  const { period, startDate, endDate } = args;
  const dateFilter = resolveDateRange(period, startDate, endDate);

  const grouped = await prisma.expense.groupBy({
    by: ["category"],
    _sum: { amount: true },
    where: {
      payerId: currentUserId,
      date: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
    },
  });

  return grouped.map((g) => ({
    category: g.category,
    total: g._sum.amount || 0,
  }));
}
```

**Step 3: Create `types/get-expenses-by-category.type.ts`**

```typescript
import { z } from "zod";

export const getExpensesByCategorySchema = z.object({
  category: z.string(),
  period: z.enum(["this_week", "last_week", "this_month", "last_month", "this_year"]).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});
```

**Step 4: Create `tools/get-expenses-by-category.tool.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../db";
import { getExpensesByCategorySchema } from "../types";
import { resolveDateRange } from "../lib";

export async function getExpensesByCategory(
  args: z.infer<typeof getExpensesByCategorySchema>,
  currentUserId: string
) {
  const { category, period, startDate, endDate } = args;
  const dateFilter = resolveDateRange(period, startDate, endDate);

  return await prisma.expense.findMany({
    where: {
      payerId: currentUserId,
      category,
      date: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
    },
    orderBy: { date: "desc" },
  });
}
```

**Step 5: Write test**

Create: `tests/get-expenses-by-category.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { getExpensesByCategory } from "../tools/get-expenses-by-category.tool";
import { prisma } from "../db";

vi.mock("../db", () => ({
  prisma: {
    expense: { findMany: vi.fn() },
  },
}));

describe("getExpensesByCategory", () => {
  it("filters by category and user", async () => {
    vi.mocked(prisma.expense.findMany).mockResolvedValue([]);
    const result = await getExpensesByCategory({ category: "Travel" }, "u1");
    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ category: "Travel", payerId: "u1" }) })
    );
  });
});
```

**Step 6: Run tests**

Run: `npx vitest run tests/get-summary.test.ts tests/get-expenses-by-category.test.ts`
Expected: `PASS`

**Step 7: Update exports**

Add to `types/index.ts`:
```typescript
export { getExpensesByCategorySchema } from "./get-expenses-by-category.type";
```

Add to `tools/index.ts`:
```typescript
export { getExpensesByCategory } from "./get-expenses-by-category.tool";
```

**Step 8: Commit**

```bash
git add tools/get-summary.tool.ts tools/get-expenses-by-category.tool.ts types/ tests/
git commit -m "feat: update get-summary, add get-expenses-by-category with period filtering"
```

---

### Task 7: Switch Transport to HTTP + Wire Google OAuth

**Files:**
- Modify: `main.ts`
- Modify: `.env` (add new vars — do NOT commit)
- Create: `README.md` (update with setup instructions)

**Step 1: Install required packages**

Run: `pnpm add dotenv`
Expected: package added

**Step 2: Update `main.ts` to use httpStream transport and GoogleProvider**

```typescript
import "dotenv/config";
import { FastMCP, GoogleProvider } from "fastmcp";
import { resolveUser } from "./lib";
import {
  addExpenseSchema,
  listExpensesSchema,
  updateExpenseSchema,
  deleteExpenseSchema,
  getSummarySchema,
  addFriendSchema,
  createGroupSchema,
  addGroupMemberSchema,
  getExpensesByCategorySchema,
} from "./types";
import {
  addExpense,
  listExpenses,
  updateExpense,
  deleteExpense,
  getSummary,
  addFriend,
  listFriends,
  createGroup,
  listGroups,
  addGroupMember,
  getExpensesByCategory,
  getSplitHistory,
  getSplitHistorySchema,
  settleUp,
  settleSplitSchema,
} from "./tools";

const server = new FastMCP({
  name: "Expense Tracker",
  version: "1.0.0",
  auth: new GoogleProvider({
    baseUrl: process.env.BASE_URL!,
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    scopes: ["openid", "profile", "email"],
  }),
});

// Helper for tools that need auth
async function getUser(session: any) {
  return resolveUser({
    googleId: session.user.googleId,
    email: session.user.email,
    name: session.user.name,
  });
}

// ─── Profile ────────────────────────────────────────────────────────────────
server.addTool({
  name: "get-my-profile",
  description: "Get the current user profile",
  parameters: {},
  execute: async (_, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(user, null, 2);
  },
});

// ─── Friends ────────────────────────────────────────────────────────────────
server.addTool({
  name: "add-friend",
  description: "Add a friend by email",
  parameters: addFriendSchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await addFriend(args, user.id), null, 2);
  },
});

server.addTool({
  name: "list-friends",
  description: "List all friends",
  parameters: {},
  execute: async (_, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await listFriends(user.id), null, 2);
  },
});

// ─── Groups ─────────────────────────────────────────────────────────────────
server.addTool({
  name: "create-group",
  description: "Create a group with friends",
  parameters: createGroupSchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await createGroup(args, user.id), null, 2);
  },
});

server.addTool({
  name: "list-groups",
  description: "List all groups you belong to",
  parameters: {},
  execute: async (_, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await listGroups(user.id), null, 2);
  },
});

server.addTool({
  name: "add-group-member",
  description: "Add a member to a group",
  parameters: addGroupMemberSchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await addGroupMember(args, user.id), null, 2);
  },
});

// ─── Expenses ───────────────────────────────────────────────────────────────
server.addTool({
  name: "add-expense",
  description: "Add an expense, optionally splitting it with friends",
  parameters: addExpenseSchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await addExpense(args, user.id), null, 2);
  },
});

server.addTool({
  name: "list-expenses",
  description: "List expenses with optional filters",
  parameters: listExpensesSchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await listExpenses(args, user.id), null, 2);
  },
});

server.addTool({
  name: "update-expense",
  description: "Update an existing expense",
  parameters: updateExpenseSchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await updateExpense(args, user.id), null, 2);
  },
});

server.addTool({
  name: "delete-expense",
  description: "Delete an expense",
  parameters: deleteExpenseSchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await deleteExpense(args, user.id), null, 2);
  },
});

server.addTool({
  name: "get-split-history",
  description: "View your split history with friends",
  parameters: getSplitHistorySchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await getSplitHistory(args, user.id), null, 2);
  },
});

server.addTool({
  name: "settle-split",
  description: "Mark a split as settled when a friend pays you",
  parameters: settleSplitSchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await settleUp(args, user.id), null, 2);
  },
});

// ─── Summary ────────────────────────────────────────────────────────────────
server.addTool({
  name: "get-expenses-summary-by-category",
  description: "Get total expenses grouped by category",
  parameters: getSummarySchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await getSummary(args, user.id), null, 2);
  },
});

server.addTool({
  name: "get-expenses-by-category",
  description: "Get all expenses in a specific category, optionally filtered by date",
  parameters: getExpensesByCategorySchema,
  execute: async (args, { session }) => {
    const user = await getUser(session);
    return JSON.stringify(await getExpensesByCategory(args, user.id), null, 2);
  },
});

// ─── Start ──────────────────────────────────────────────────────────────────
server.start({
  transportType: "httpStream",
  httpStream: { port: Number(process.env.PORT ?? 3000) },
});
```

**Step 3: Verify server starts**

Run: `npx tsx main.ts`
Expected: Server starts on port 3000 without TypeScript errors. Stop with Ctrl+C.

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add main.ts
git commit -m "feat: wire all tools to httpStream server with Google OAuth"
```

---

### Task 8: Update list-expenses & update/delete-expense to scope by user

**Files:**
- Modify: `tools/list-expenses.tool.ts`
- Modify: `tools/update-expense.tool.ts`
- Modify: `tools/delete-expense.tool.ts`

**Step 1: Update `tools/list-expenses.tool.ts` to accept `currentUserId`**

```typescript
import { z } from "zod";
import { prisma } from "../db";
import { listExpensesSchema } from "../types";
import { resolveDateRange } from "../lib";

export async function listExpenses(
  args: z.infer<typeof listExpensesSchema>,
  currentUserId: string
) {
  const { category, startDate, endDate } = args;
  const dateFilter = resolveDateRange(undefined, startDate, endDate);

  return await prisma.expense.findMany({
    where: {
      payerId: currentUserId,
      category,
      date: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
    },
    include: { splits: { include: { user: true } } },
    orderBy: { date: "desc" },
  });
}
```

**Step 2: Update `tools/update-expense.tool.ts` to verify ownership**

```typescript
import { z } from "zod";
import { prisma } from "../db";
import { updateExpenseSchema } from "../types";

export async function updateExpense(
  args: z.infer<typeof updateExpenseSchema>,
  currentUserId: string
) {
  const { id, ...data } = args;

  const expense = await prisma.expense.findUnique({ where: { id } });
  if (!expense || expense.payerId !== currentUserId) {
    throw new Error("Expense not found or you don't have permission to update it.");
  }

  return await prisma.expense.update({
    where: { id },
    data: { ...data, date: data.date ? new Date(data.date) : undefined },
  });
}
```

**Step 3: Update `tools/delete-expense.tool.ts` to verify ownership**

```typescript
import { z } from "zod";
import { prisma } from "../db";
import { deleteExpenseSchema } from "../types";

export async function deleteExpense(
  args: z.infer<typeof deleteExpenseSchema>,
  currentUserId: string
) {
  const { id } = args;

  const expense = await prisma.expense.findUnique({ where: { id } });
  if (!expense || expense.payerId !== currentUserId) {
    throw new Error("Expense not found or you don't have permission to delete it.");
  }

  // Delete splits first (FK constraint)
  await prisma.expenseSplit.deleteMany({ where: { expenseId: id } });

  return await prisma.expense.delete({ where: { id } });
}
```

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add tools/list-expenses.tool.ts tools/update-expense.tool.ts tools/delete-expense.tool.ts
git commit -m "feat: scope list/update/delete expense operations to current user"
```
