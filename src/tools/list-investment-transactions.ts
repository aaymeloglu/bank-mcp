import { z } from "zod";
import { loadConfig, getConnection, getConnectionForAccount, getAllConnections } from "../config.js";
import { getProvider } from "../providers/registry.js";
import { cache, TTL } from "../utils/cache.js";
import type { InvestmentTransaction } from "../types.js";

export const listInvestmentTransactionsSchema = z.object({
  connectionId: z
    .string()
    .optional()
    .describe("Connection ID. If omitted, queries all connections (or resolved from accountId)."),
  accountId: z
    .string()
    .optional()
    .describe("Account UID. If omitted, queries all investment accounts."),
  dateFrom: z
    .string()
    .optional()
    .describe("Start date (YYYY-MM-DD). Defaults to 90 days ago."),
  dateTo: z
    .string()
    .optional()
    .describe("End date (YYYY-MM-DD). Defaults to today."),
  type: z
    .string()
    .optional()
    .describe('Filter by type, e.g. "buy", "sell", "cash", "fee", "transfer".'),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of transactions to return."),
});

export async function listInvestmentTransactions(
  args: z.infer<typeof listInvestmentTransactionsSchema>,
): Promise<InvestmentTransaction[]> {
  const config = loadConfig();
  const dateFrom = args.dateFrom || defaultDateFrom(config.defaults.transactionDays);
  const dateTo = args.dateTo || today();

  const explicit = Boolean(args.accountId || args.connectionId);
  const connections = args.accountId && !args.connectionId
    ? [getConnectionForAccount(config, args.accountId)]
    : args.connectionId
      ? [getConnection(config, args.connectionId)]
      : getAllConnections(config);

  const all: InvestmentTransaction[] = [];

  for (const conn of connections) {
    const provider = getProvider(conn.provider);
    if (!provider.listInvestmentTransactions) {
      if (explicit) {
        throw new Error(`Provider "${conn.provider}" does not support investment transactions`);
      }
      continue;
    }

    const cacheKey = `itx:${conn.id}:${args.accountId ?? "*"}:${dateFrom}:${dateTo}`;
    let txs = cache.get<InvestmentTransaction[]>(cacheKey);
    if (!txs) {
      txs = await provider.listInvestmentTransactions(
        conn.config,
        args.accountId ? [args.accountId] : undefined,
        { dateFrom, dateTo },
      );
      cache.set(cacheKey, txs, TTL.TRANSACTIONS);
    }
    all.push(...(args.type ? txs.filter((t) => t.type === args.type) : txs));
  }

  // Most recent first
  all.sort((a, b) => b.date.localeCompare(a.date));

  return args.limit ? all.slice(0, args.limit) : all;
}

function defaultDateFrom(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
