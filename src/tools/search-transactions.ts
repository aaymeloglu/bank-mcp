import { z } from "zod";
import { listTransactions } from "./list-transactions.js";
import type { Transaction } from "../types.js";

export const searchTransactionsSchema = z.object({
  query: z
    .string()
    .describe("Search text — matched against description, merchant name, and reference."),
  connectionId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  limit: z.number().optional().describe("Max results. Default 50."),
});

export async function searchTransactions(
  args: z.infer<typeof searchTransactionsSchema>,
): Promise<Transaction[]> {
  // Fetch all transactions for the date range, then filter locally
  const transactions = await listTransactions({
    connectionId: args.connectionId,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
  });

  const q = args.query.toLowerCase();
  const limit = args.limit || 50;

  const matches = transactions.filter((t) => {
    const fields = [t.description, t.merchantName, t.reference].filter(Boolean);
    return fields.some((f) => f!.toLowerCase().includes(q));
  });

  return matches.slice(0, limit);
}
