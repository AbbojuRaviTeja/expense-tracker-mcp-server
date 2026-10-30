# Expense Tracker MCP Server Design

## Overview
An MCP Server for expense tracking, enabling AI agents to manage and query expenses. The server is built using Neon (PostgreSQL) and Prisma ORM.

## Architecture
- **Framework**: `fastmcp`
- **Database**: PostgreSQL on Neon
- **ORM**: Prisma ORM

## Data Model
The base model will be `Expense`. To easily support a future splitwise-like multi-user architecture, we will include an optional `userId` string field initially to ensure the API and database schema are extensible when user authentication/management is introduced.

### `Expense` Schema
- `id`: String (UUID, primary key)
- `amount`: Float
- `category`: String
- `description`: String (optional)
- `date`: DateTime
- `userId`: String (optional, reserved for future multi-user support)
- `createdAt`: DateTime
- `updatedAt`: DateTime

## Tools 
The server will expose the following tools to the AI client:

1. **`addExpense`**
   - **Inputs**: `amount` (number), `category` (string), `description` (string, optional), `date` (string/datetime)
   - **Outputs**: The created `Expense` object.

2. **`listExpenses`**
   - **Inputs**: Optional filters like `startDate` and `endDate`.
   - **Outputs**: Array of `Expense` records.

3. **`updateExpense`**
   - **Inputs**: `id` (required), plus any fields to update.
   - **Outputs**: The updated `Expense` object.

4. **`deleteExpense`**
   - **Inputs**: `id` (required).
   - **Outputs**: Success confirmation.

5. **`getExpensesSummaryByCategory`**
   - **Inputs**: Optional `startDate` and `endDate` filters.
   - **Outputs**: Raw JSON aggregation (category -> total amount). The AI client will consume this to draw pie charts or provide analytical summaries.

## Future Scope (Multi-User)
- The architecture allows future extensions like a `User` model, multiple participants, balances, and partial settlements, akin to Splitwise.
- Future enhancements will make the currently optional `userId` mandatory and introduce group relations.
