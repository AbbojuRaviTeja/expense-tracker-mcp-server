# Splitwise-Style Multi-User Expense Splitting — Design

## Goal

Expand the expense tracker MCP server with multi-user support, Google OAuth, friend management, groups, and expense splitting — modelled after Splitwise.

---

## 1. Data Model

### User
```prisma
model User {
  id         String   @id @default(uuid())
  googleId   String?  @unique       // null until they log in
  email      String   @unique
  name       String?
  status     UserStatus @default(INVITED)
  createdAt  DateTime @default(now())

  // Relations
  expenses        Expense[]       @relation("Payer")
  splits          ExpenseSplit[]
  sentFriendships     Friendship[] @relation("Requester")
  receivedFriendships Friendship[] @relation("Addressee")
  groupMemberships    GroupMember[]
  createdGroups       Group[]
}

enum UserStatus {
  ACTIVE
  INVITED
}
```

**Key rule:** A `User` can be pre-created with just an email (`INVITED` status). When they log in via Google, `googleId` and `name` are filled in and status becomes `ACTIVE`.

---

### Friendship
```prisma
model Friendship {
  id          String   @id @default(uuid())
  requesterId String
  addresseeId String
  status      FriendshipStatus @default(ACCEPTED)
  createdAt   DateTime @default(now())

  requester User @relation("Requester", fields: [requesterId], references: [id])
  addressee User @relation("Addressee", fields: [addresseeId], references: [id])

  @@unique([requesterId, addresseeId])
}

enum FriendshipStatus {
  PENDING
  ACCEPTED
}
```

---

### Group & GroupMember
```prisma
model Group {
  id          String   @id @default(uuid())
  name        String
  createdById String
  createdAt   DateTime @default(now())

  createdBy User          @relation(fields: [createdById], references: [id])
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
```

---

### Expense (updated)
```prisma
model Expense {
  id          String   @id @default(uuid())
  amount      Float
  category    String
  description String?
  date        DateTime
  payerId     String                   // required (replaces optional userId)
  groupId     String?                  // optional group context
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  payer  User           @relation("Payer", fields: [payerId], references: [id])
  group  Group?         @relation(fields: [groupId], references: [id])
  splits ExpenseSplit[]
}
```

---

### ExpenseSplit
```prisma
model ExpenseSplit {
  id         String    @id @default(uuid())
  expenseId  String
  userId     String
  amount     Float
  paid       Boolean   @default(false)
  settledAt  DateTime?
  createdAt  DateTime  @default(now())

  expense Expense @relation(fields: [expenseId], references: [id])
  user    User    @relation(fields: [userId], references: [id])
}
```

---

## 2. MCP Tools

### Auth / Profile
| Tool | Params | Description |
|------|--------|-------------|
| `get-my-profile` | — | Returns current user's info from session |

### Friends
| Tool | Params | Description |
|------|--------|-------------|
| `add-friend` | `email` | Looks up or creates INVITED placeholder, creates Friendship |
| `list-friends` | — | Returns all friends with status |

### Groups
| Tool | Params | Description |
|------|--------|-------------|
| `create-group` | `name`, `memberEmails[]` | Creates group, adds members (creates placeholders if needed) |
| `list-groups` | — | Returns all groups the user belongs to |
| `add-group-member` | `groupId`, `email` | Adds a friend to an existing group |

### Expenses & Splits
| Tool | Params | Description |
|------|--------|-------------|
| `add-expense` *(updated)* | `amount`, `category`, `description?`, `date`, `splitWith?: email[]`, `groupId?` | Creates expense + ExpenseSplit rows for each person |
| `list-expenses` *(updated)* | `groupId?`, `period?`, `startDate?`, `endDate?` | Lists expenses scoped to current user |
| `update-expense` | `id`, `amount?`, `category?`, `description?`, `date?` | Updates expense fields |
| `delete-expense` | `id` | Deletes expense and its splits |
| `get-split-history` | `friendEmail?`, `paid?` | Returns all splits involving current user |
| `settle-split` | `friendEmail` | Finds open splits with friend; if multiple, returns list for user to pick; marks chosen as paid |

### Summary & Filtering
| Tool | Params | Description |
|------|--------|-------------|
| `get-expenses-summary-by-category` *(updated)* | `period?`, `startDate?`, `endDate?` | Grouped by category, scoped to user |
| `get-expenses-by-category` | `category`, `period?`, `startDate?`, `endDate?` | All expenses in a single category in date range |

**Total: 13 tools**

---

## 3. Date Utility

A shared `resolveDateRange(period?, startDate?, endDate?)` utility resolves all date filtering consistently:

```typescript
type Period = "this_week" | "last_week" | "this_month" | "last_month" | "this_year";

function resolveDateRange(period?: Period, startDate?: string, endDate?: string): { gte?: Date; lte?: Date }
```

All tools that accept date ranges use this utility. Dates stored and compared in UTC.

---

## 4. Auth & Transport

- **Transport:** `httpStream` on port `3000` (configurable via `PORT` env var)
- **Auth:** FastMCP `GoogleProvider` with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BASE_URL`
- **User resolution:** `resolveUser(session)` helper runs in every authenticated tool — upserts user by `googleId`, or activates INVITED placeholder matched by email
- **Scoping:** All queries filter by `payerId` or user's splits — no cross-user data leakage

### Required environment variables
```
DATABASE_URL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
BASE_URL=http://localhost:3000   # or production URL
PORT=3000
```

---

## 5. Error Handling

| Scenario | Behavior |
|----------|----------|
| Friend email not found | Create INVITED placeholder + Friendship, inform user |
| `settle-split` with multiple open splits | Return list of open splits so user can pick |
| User not in group | Return 403-style error message |
| Invalid date range | Zod validation error before DB query |

---

## 6. Migration Strategy

The existing `Expense.userId` (optional String) is replaced by `Expense.payerId` (required FK to User). A Prisma migration will handle this. Existing expense rows without a userId will need to be addressed (for a fresh dev DB, just reset; for prod, a data migration script sets a default user).
