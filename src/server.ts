import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { listAccountsSchema, listAccounts } from "./tools/list-accounts.js";
import {
  listTransactionsSchema,
  listTransactions,
} from "./tools/list-transactions.js";
import {
  searchTransactionsSchema,
  searchTransactions,
} from "./tools/search-transactions.js";
import { getBalanceSchema, getBalance } from "./tools/get-balance.js";
import { getHoldingsSchema, getHoldings } from "./tools/get-holdings.js";
import {
  listInvestmentTransactionsSchema,
  listInvestmentTransactions,
} from "./tools/list-investment-transactions.js";
import {
  spendingSummarySchema,
  spendingSummary,
} from "./tools/spending-summary.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json") as { version: string };

// ---------------------------------------------------------------------------
// Output schemas (mirror src/types.ts; arrays are wrapped because MCP
// structuredContent must be an object).
// ---------------------------------------------------------------------------

const bankAccountSchema = z.object({
  uid: z.string(),
  iban: z.string(),
  name: z.string(),
  currency: z.string(),
  connectionId: z.string(),
});

const transactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.string().describe("YYYY-MM-DD"),
  amount: z.number().describe("Signed: negative = expense"),
  currency: z.string(),
  description: z.string(),
  merchantName: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(["debit", "credit"]),
  reference: z.string().optional(),
  rawData: z.record(z.string(), z.unknown()).optional(),
});

const balanceSchema = z.object({
  accountId: z.string(),
  amount: z.number(),
  currency: z.string(),
  type: z.string().describe('"closingBooked" | "expected" | etc.'),
});

const fixedIncomeSchema = z.object({
  couponRate: z.number().optional().describe("Percent, e.g. 5 for 5.000%"),
  maturityDate: z.string().optional().describe("YYYY-MM-DD"),
  callDate: z.string().optional().describe("YYYY-MM-DD"),
  callPrice: z.number().optional().describe("Per 100 face"),
});

const holdingSchema = z.object({
  accountId: z.string(),
  securityId: z.string(),
  name: z.string(),
  type: z.string().optional(),
  ticker: z.string().optional(),
  cusip: z.string().optional(),
  isCashEquivalent: z.boolean(),
  quantity: z.number().describe("Shares, or face value for bonds"),
  price: z.number().optional().describe("Bonds: per 100 face"),
  priceAsOf: z.string().optional(),
  value: z.number(),
  costBasis: z.number().optional(),
  currency: z.string(),
  fixedIncome: fixedIncomeSchema.optional(),
});

const investmentTransactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.string().describe("YYYY-MM-DD"),
  name: z.string(),
  type: z.string(),
  subtype: z.string().optional(),
  quantity: z.number(),
  price: z.number(),
  amount: z.number().describe("Signed: negative = cash leaving the account"),
  fees: z.number().optional(),
  currency: z.string(),
  securityId: z.string().optional(),
  securityName: z.string().optional(),
  ticker: z.string().optional(),
});

const spendingGroupSchema = z.object({
  name: z.string(),
  totalSpent: z.number(),
  transactionCount: z.number(),
  currency: z.string(),
});

const accountsOutput = z.object({ accounts: z.array(bankAccountSchema) });
const transactionsOutput = z.object({ transactions: z.array(transactionSchema) });
const balancesOutput = z.object({ balances: z.array(balanceSchema) });
const holdingsOutput = z.object({ holdings: z.array(holdingSchema) });
const investmentTransactionsOutput = z.object({
  transactions: z.array(investmentTransactionSchema),
});
const spendingSummaryOutput = z.object({
  groups: z.array(spendingGroupSchema),
  totalSpent: z.number(),
  currency: z.string(),
  period: z.string(),
});

// Every tool is a read against the bank provider: no side effects, safe to retry.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// Result helpers. The text block stays the plain JSON of the tool's result
// (what clients have always seen); structuredContent carries the schema shape.
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(text: unknown, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(text, null, 2) }],
    structuredContent: structured,
  };
}

// Return errors as structured text so LLMs can explain them.
function toolError(err: unknown, code = "tool_error"): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: true, code, message }) }],
    isError: true,
  };
}

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolError(err);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "bank-mcp", version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to bank accounts, balances and transactions across the configured " +
        "connections, plus brokerage holdings and investment transactions where the provider " +
        "supports them. Start with list_accounts to learn account UIDs and connection IDs; " +
        "list_transactions defaults to the last 90 days. Amounts are signed (negative = expense).",
    },
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "List all bank accounts across configured connections. Returns account UIDs, IBANs, names, and currencies.",
      inputSchema: listAccountsSchema.shape,
      outputSchema: accountsOutput.shape,
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const accounts = await listAccounts(args);
        return ok(accounts, { accounts });
      }),
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description:
        "List bank transactions with optional filters. Defaults to last 90 days. Supports date range, amount range, and debit/credit type filtering.",
      inputSchema: listTransactionsSchema.shape,
      outputSchema: transactionsOutput.shape,
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const transactions = await listTransactions(args);
        return ok(transactions, { transactions });
      }),
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "Full-text search across transaction descriptions, merchant names, and references. Use for finding specific payments or payees.",
      inputSchema: searchTransactionsSchema.shape,
      outputSchema: transactionsOutput.shape,
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const transactions = await searchTransactions(args);
        return ok(transactions, { transactions });
      }),
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get balance",
      description:
        "Get current account balance(s). Returns closing booked balance and expected balance when available.",
      inputSchema: getBalanceSchema.shape,
      outputSchema: balancesOutput.shape,
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const balances = await getBalance(args);
        return ok(balances, { balances });
      }),
  );

  server.registerTool(
    "get_holdings",
    {
      title: "Get holdings",
      description:
        "Current positions in brokerage/investment accounts: security, quantity (face value for bonds), price, value, cost basis, and for bonds the coupon, maturity and call date when the broker provides them. Cash and money market funds are included with isCashEquivalent=true.",
      inputSchema: getHoldingsSchema.shape,
      outputSchema: holdingsOutput.shape,
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const holdings = await getHoldings(args);
        return ok(holdings, { holdings });
      }),
  );

  server.registerTool(
    "list_investment_transactions",
    {
      title: "List investment transactions",
      description:
        "Buys, sells, interest/dividends, fees and transfers in brokerage/investment accounts. Defaults to last 90 days. Amounts are signed (negative = cash leaving the account).",
      inputSchema: listInvestmentTransactionsSchema.shape,
      outputSchema: investmentTransactionsOutput.shape,
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const transactions = await listInvestmentTransactions(args);
        return ok(transactions, { transactions });
      }),
  );

  server.registerTool(
    "spending_summary",
    {
      title: "Spending summary",
      description:
        'Group expenses by merchant or category with totals. Shows where money is being spent. Use groupBy "merchant" for vendor breakdown, "category" for category breakdown.',
      inputSchema: spendingSummarySchema.shape,
      outputSchema: spendingSummaryOutput.shape,
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const summary = await spendingSummary(args);
        return ok(summary, summary);
      }),
  );

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // All logging to stderr — stdout is the MCP wire protocol
  console.error(`[bank-mcp] Server ${SERVER_VERSION} started`);
}
