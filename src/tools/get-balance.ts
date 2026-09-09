import { z } from "zod";
import { loadConfig, getConnection, getConnectionForAccount, getAllConnections } from "../config.js";
import { getProvider } from "../providers/registry.js";
import { cache, TTL } from "../utils/cache.js";
import type { Balance } from "../types.js";

export const getBalanceSchema = z.object({
  connectionId: z.string().optional(),
  accountId: z.string().optional().describe("Account UID. If omitted, returns balances for all accounts."),
});

export async function getBalance(
  args: z.infer<typeof getBalanceSchema>,
): Promise<Balance[]> {
  const config = loadConfig();

  // If accountId is given without connectionId, resolve it from config
  const connections = args.accountId && !args.connectionId
    ? [getConnectionForAccount(config, args.accountId)]
    : args.connectionId
      ? [getConnection(config, args.connectionId)]
      : getAllConnections(config);

  // Balance fetches are the slow path (Plaid polls the bank live), so: one batched
  // request per connection where the provider supports it (also keeps us under
  // Plaid's per-item BALANCE_LIMIT), otherwise per-account requests run
  // concurrently. Connections are fetched in parallel; result order is preserved.
  const perConnection = await Promise.all(
    connections.map(async (conn) => {
      const provider = getProvider(conn.provider);

      if (provider.getBalances) {
        const cacheKey = `bal:${conn.id}:${args.accountId ?? "*"}`;
        const cached = cache.get<Balance[]>(cacheKey);
        if (cached) return cached;

        const balances = await provider.getBalances(
          conn.config,
          args.accountId ? [args.accountId] : undefined,
        );
        cache.set(cacheKey, balances, TTL.BALANCES);
        return balances;
      }

      const accountIds = args.accountId
        ? [args.accountId]
        : (await provider.listAccounts(conn.config)).map((a) => a.uid);

      const perAccount = await Promise.all(
        accountIds.map(async (accId) => {
          const cacheKey = `bal:${conn.id}:${accId}`;
          const cached = cache.get<Balance[]>(cacheKey);
          if (cached) return cached;

          const balances = await provider.getBalance(conn.config, accId);
          cache.set(cacheKey, balances, TTL.BALANCES);
          return balances;
        }),
      );
      return perAccount.flat();
    }),
  );

  return perConnection.flat();
}
