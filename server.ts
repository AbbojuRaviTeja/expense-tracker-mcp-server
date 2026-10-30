import { Prisma } from "@prisma/client";
import { FastMCP, GoogleProvider, UserError } from "fastmcp";
import { z } from "zod";
import type { AppConfig } from "./lib/config";
import { AppError } from "./lib/errors";
import { fastmcpLogger, logger } from "./lib/logger";
import { RateLimiter } from "./lib/rate-limit";
import { resolveUserId, type GoogleSession } from "./lib/resolve-user";
import {
  addExpense,
  addFriend,
  addGroupMember,
  addRecurringExpense,
  cancelRecurringExpense,
  createGroup,
  deleteBudget,
  deleteExpense,
  exportExpensesCsv,
  getBalances,
  getBudgetStatus,
  getExpensesByCategory,
  getGroupBalances,
  getMyProfile,
  getSplitHistory,
  getSummary,
  importExpenses,
  listExpenses,
  listFriends,
  listGroups,
  listPendingPayments,
  listRecurringExpenses,
  maybeMaterializeRecurring,
  respondToPayment,
  sendReminder,
  setBudget,
  settleUp,
  updateExpense,
  updateMySettings,
} from "./tools";
import {
  addExpenseSchema,
  addFriendSchema,
  addGroupMemberSchema,
  addRecurringExpenseSchema,
  cancelRecurringSchema,
  createGroupSchema,
  deleteBudgetSchema,
  deleteExpenseSchema,
  exportExpensesSchema,
  getBalancesSchema,
  getExpensesByCategorySchema,
  getSplitHistorySchema,
  getSummarySchema,
  groupIdSchema,
  importExpensesSchema,
  listExpensesSchema,
  respondToPaymentSchema,
  sendReminderSchema,
  setBudgetSchema,
  settleUpSchema,
  updateExpenseSchema,
  updateSettingsSchema,
} from "./types";

const INSTRUCTIONS = `Expense tracker and bill splitter (like Splitwise).
- Amounts are in normal currency units (249.50), never paise/cents.
- Dates accept YYYY-MM-DD, ISO date-times, "today" or "yesterday", in the user's time zone.
- If get-my-profile shows time zone UTC, suggest setting the real one with update-my-settings.
- People are identified by email; "me" means the signed-in user.
- Use get-balances to answer "who owes whom", get-group-balances for the simplest way to settle a group.
- For receipts: read the items from the image and call add-expense with splitType "itemized".
- add-expense may return budgetAlerts; always tell the user about them.`;

interface Annotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Converts any error into a message safe to show the user; logs the real cause. */
function toUserError(err: unknown, tool: string, userId?: string): UserError {
  if (err instanceof AppError) {
    logger.info("tool rejected", { tool, userId, reason: err.message });
    return new UserError(err.message);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const known: Record<string, string> = {
      P2025: "That record was not found.",
      P2002: "That already exists.",
      P2003: "Something you referenced (like a group or expense id) does not exist.",
    };
    if (known[err.code]) {
      logger.info("tool rejected", { tool, userId, prismaCode: err.code });
      return new UserError(known[err.code]);
    }
  }
  logger.error("tool failed", { tool, userId, err });
  return new UserError("Something went wrong on the server. Please try again.");
}

export function createServer(config: AppConfig) {
  const server = new FastMCP({
    name: "Expense tracker",
    version: "2.0.0",
    instructions: INSTRUCTIONS,
    logger: fastmcpLogger,
    health: { enabled: true, path: "/health", message: "ok" },
    auth: new GoogleProvider({
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      baseUrl: config.BASE_URL,
    }),
  });

  const limiter = new RateLimiter(config.RATE_LIMIT_PER_MINUTE);

  async function authenticate(session: unknown): Promise<string> {
    if (!session) throw new AppError("You are not signed in. Please sign in with Google.");
    return resolveUserId(session as GoogleSession);
  }

  function tool<S extends z.ZodObject>(def: {
    name: string;
    description: string;
    parameters: S;
    annotations: Annotations;
    run: (args: z.infer<S>, userId: string) => Promise<unknown>;
  }) {
    server.addTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      annotations: def.annotations,
      execute: async (args, { session }) => {
        const started = Date.now();
        let userId: string | undefined;
        try {
          userId = await authenticate(session);
          limiter.check(userId);
          await maybeMaterializeRecurring(userId);
          const result = await def.run(args as z.infer<S>, userId);
          logger.info("tool ok", { tool: def.name, userId, ms: Date.now() - started });
          return typeof result === "string" ? result : JSON.stringify(result, null, 2);
        } catch (err) {
          throw toUserError(err, def.name, userId);
        }
      },
    });
  }

  const none = z.object({});
  const read = (title: string): Annotations => ({ title, readOnlyHint: true, openWorldHint: false });
  const write = (title: string, extra: Partial<Annotations> = {}): Annotations => ({
    title,
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    ...extra,
  });

  // Profile
  tool({
    name: "get-my-profile",
    description: "Show your profile, time zone, default currency and account stats. Creates your account on first use.",
    parameters: none,
    annotations: read("My profile"),
    run: async (_args, userId) => getMyProfile(userId),
  });
  tool({
    name: "update-my-settings",
    description: "Change your time zone (used for 'this month', 'today' etc.), default currency or display name.",
    parameters: updateSettingsSchema,
    annotations: write("Update settings", { idempotentHint: true }),
    run: updateMySettings,
  });

  // Expenses
  tool({
    name: "add-expense",
    description:
      "Record an expense you paid. Optionally split it equally, by exact amounts, percentages, shares, or itemized from a receipt, " +
      "with friends or a group. Returns budget alerts if you are close to or over a budget.",
    parameters: addExpenseSchema,
    annotations: write("Add expense"),
    run: addExpense,
  });
  tool({
    name: "list-expenses",
    description: "List expenses you paid for or have a share in, newest first, with filters and paging.",
    parameters: listExpensesSchema,
    annotations: read("List expenses"),
    run: listExpenses,
  });
  tool({
    name: "update-expense",
    description:
      "Edit an expense you paid. Changing the amount rescales everyone's share; pass split fields to re-split it differently.",
    parameters: updateExpenseSchema,
    annotations: write("Update expense", { idempotentHint: true }),
    run: updateExpense,
  });
  tool({
    name: "delete-expense",
    description: "Permanently delete an expense you paid, along with everyone's shares of it. Confirm with the user first.",
    parameters: deleteExpenseSchema,
    annotations: write("Delete expense", { destructiveHint: true, idempotentHint: true }),
    run: deleteExpense,
  });
  tool({
    name: "get-expenses-summary-by-category",
    description:
      "Spending per category with totals and percentages (good for pie charts). Counts only YOUR share of shared expenses; " +
      "pass groupId to see a whole group's spending instead.",
    parameters: getSummarySchema,
    annotations: read("Spending summary"),
    run: getSummary,
  });
  tool({
    name: "get-expenses-by-category",
    description: "List expenses in one category, plus the total of your share.",
    parameters: getExpensesByCategorySchema,
    annotations: read("Expenses in a category"),
    run: getExpensesByCategory,
  });
  tool({
    name: "import-expenses",
    description:
      "Bulk-add up to 500 personal expenses, e.g. parsed from a bank statement, CSV, or UPI/bank SMS messages. Skips duplicates by default.",
    parameters: importExpensesSchema,
    annotations: write("Import expenses"),
    run: importExpenses,
  });
  tool({
    name: "export-expenses-csv",
    description: "Export your expenses (including your share of each) as CSV text for spreadsheets.",
    parameters: exportExpensesSchema,
    annotations: read("Export CSV"),
    run: exportExpensesCsv,
  });

  // Friends and groups
  tool({
    name: "add-friend",
    description: "Add a friend by email. If they have not joined yet, they are invited and see shared expenses when they sign in.",
    parameters: addFriendSchema,
    annotations: write("Add friend", { idempotentHint: true, openWorldHint: true }),
    run: addFriend,
  });
  tool({
    name: "list-friends",
    description: "List your friends and how much each of them owes you or you owe them.",
    parameters: none,
    annotations: read("List friends"),
    run: async (_args, userId) => listFriends(userId),
  });
  tool({
    name: "create-group",
    description: "Create a group (trip, flat, team) for shared expenses. You are added automatically.",
    parameters: createGroupSchema,
    annotations: write("Create group"),
    run: createGroup,
  });
  tool({
    name: "list-groups",
    description: "List the groups you belong to, with members.",
    parameters: none,
    annotations: read("List groups"),
    run: async (_args, userId) => listGroups(userId),
  });
  tool({
    name: "add-group-member",
    description: "Add someone to a group you are a member of.",
    parameters: addGroupMemberSchema,
    annotations: write("Add group member", { idempotentHint: true }),
    run: addGroupMember,
  });
  tool({
    name: "get-group-balances",
    description: "Each member's balance in a group, plus the smallest set of payments that would settle everyone up.",
    parameters: groupIdSchema,
    annotations: read("Group balances"),
    run: getGroupBalances,
  });

  // Balances and payments
  tool({
    name: "get-balances",
    description: "Net balance with each person: who owes you and whom you owe, per currency, after payments.",
    parameters: getBalancesSchema,
    annotations: read("Balances"),
    run: getBalances,
  });
  tool({
    name: "get-split-history",
    description: "History of shared expenses (what you lent or borrowed) and payments, optionally with one friend or in one group.",
    parameters: getSplitHistorySchema,
    annotations: read("Split history"),
    run: getSplitHistory,
  });
  tool({
    name: "settle-up",
    description:
      "Record a real payment with a friend (full or partial). If they paid you it is confirmed immediately; " +
      "if you paid them it waits for them to confirm.",
    parameters: settleUpSchema,
    annotations: write("Settle up", { openWorldHint: true }),
    run: settleUp,
  });
  tool({
    name: "list-pending-payments",
    description: "Payments waiting for your confirmation, and payments you recorded that others have not confirmed yet.",
    parameters: none,
    annotations: read("Pending payments"),
    run: async (_args, userId) => listPendingPayments(userId),
  });
  tool({
    name: "respond-to-payment",
    description: "Confirm or reject a payment someone recorded as paid to you.",
    parameters: respondToPaymentSchema,
    annotations: write("Confirm or reject payment", { idempotentHint: true }),
    run: respondToPayment,
  });
  tool({
    name: "send-reminder",
    description: "Email a friend who owes you a friendly reminder of the amount (at most once every 12 hours).",
    parameters: sendReminderSchema,
    annotations: write("Send reminder", { openWorldHint: true }),
    run: sendReminder,
  });

  // Budgets
  tool({
    name: "set-budget",
    description: "Create or change a weekly or monthly spending limit for a category, or overall if no category is given.",
    parameters: setBudgetSchema,
    annotations: write("Set budget", { idempotentHint: true }),
    run: setBudget,
  });
  tool({
    name: "get-budget-status",
    description: "How much of each budget you have used this week/month, what is left, and whether you are over.",
    parameters: none,
    annotations: read("Budget status"),
    run: async (_args, userId) => getBudgetStatus(userId),
  });
  tool({
    name: "delete-budget",
    description: "Delete one of your budgets by id.",
    parameters: deleteBudgetSchema,
    annotations: write("Delete budget", { destructiveHint: true, idempotentHint: true }),
    run: deleteBudget,
  });

  // Recurring
  tool({
    name: "add-recurring-expense",
    description:
      "Set up an expense that repeats daily, weekly, monthly or yearly (rent, subscriptions, SIPs), optionally split. " +
      "Occurrences are added automatically when due; past ones are back-filled.",
    parameters: addRecurringExpenseSchema,
    annotations: write("Add recurring expense"),
    run: addRecurringExpense,
  });
  tool({
    name: "list-recurring-expenses",
    description: "List your recurring expenses and when each one next occurs.",
    parameters: none,
    annotations: read("Recurring expenses"),
    run: async (_args, userId) => listRecurringExpenses(userId),
  });
  tool({
    name: "cancel-recurring-expense",
    description: "Stop a recurring expense. Occurrences already created are kept.",
    parameters: cancelRecurringSchema,
    annotations: write("Cancel recurring expense", { destructiveHint: true, idempotentHint: true }),
    run: cancelRecurringExpense,
  });

  // Prompts: ready-made workflows the user can pick in their MCP client.
  server.addPrompt({
    name: "monthly-report",
    description: "A spending report for a month: categories, budgets, balances and tips.",
    arguments: [{ name: "month", description: 'Month like "2026-10". Defaults to this month.', required: false }],
    load: async ({ month }) =>
      `Write my expense report for ${month ? `the month ${month}` : "this month"}.\n` +
      `1. Call get-expenses-summary-by-category for that month and show a category table with percentages.\n` +
      `2. Compare with the previous month and call out the biggest changes.\n` +
      `3. Call get-budget-status and flag anything at warning or exceeded.\n` +
      `4. Call get-balances and list who owes me and whom I owe.\n` +
      `5. End with 3 specific, practical ways to save money next month.`,
  });
  server.addPrompt({
    name: "split-receipt",
    description: "Split a restaurant or shopping receipt item by item.",
    arguments: [
      { name: "people", description: "Emails of the people sharing the bill", required: true },
      { name: "groupId", description: "Optional group id", required: false },
    ],
    load: async ({ people, groupId }) =>
      `I will share a receipt image. Read every line item and its price, and the final total including tax, tip and service charge.\n` +
      `Ask me who had each item (people: ${people}, plus "me") if it is not obvious.\n` +
      `Then call add-expense with splitType "itemized", amount = final total, and items with sharedBy for each item` +
      `${groupId ? `, groupId "${groupId}"` : ""}. Tax and tip are shared automatically in proportion to what each person ordered.\n` +
      `Finally show me who owes what.`,
  });
  server.addPrompt({
    name: "settle-group",
    description: "Work out and record the fewest payments to settle a group.",
    arguments: [{ name: "groupId", description: "Group id (see list-groups)", required: true }],
    load: async ({ groupId }) =>
      `Call get-group-balances for group ${groupId}. Show the suggested payments as a short list.\n` +
      `For each payment that involves me, ask whether it has been paid, and if yes record it with settle-up (with that groupId).`,
  });

  // Resources: read-only live views a client can attach as context.
  const resource = (uri: string, name: string, description: string, load: (userId: string) => Promise<unknown>) =>
    server.addResource({
      uri,
      name,
      description,
      mimeType: "application/json",
      load: async (auth) => {
        try {
          const userId = await authenticate(auth);
          return { text: JSON.stringify(await load(userId), null, 2) };
        } catch (err) {
          throw toUserError(err, `resource:${uri}`);
        }
      },
    });
  resource("expenses://me/balances", "My balances", "Who owes you and whom you owe.", (id) => getBalances({}, id));
  resource("expenses://me/budgets", "My budgets", "Budget usage for the current week/month.", (id) => getBudgetStatus(id));
  resource("expenses://me/summary/this-month", "This month's spending", "Spending by category this month.", (id) =>
    getSummary({ period: "this_month" }, id),
  );

  return server;
}
