import { z } from "zod";
import { loadConfig, getConnection, getConnectionForAccount, getAllConnections } from "../config.js";
import { getProvider } from "../providers/registry.js";
import { cache, TTL } from "../utils/cache.js";
import type { Holding } from "../types.js";

export const getHoldingsSchema = z.object({
  connectionId: z.string().optional(),
  accountId: z
    .string()
    .optional()
    .describe("Account UID. If omitted, returns holdings for all investment accounts."),
});

export async function getHoldings(
  args: z.infer<typeof getHoldingsSchema>,
): Promise<Holding[]> {
  const config = loadConfig();

  const explicit = Boolean(args.accountId || args.connectionId);
  const connections = args.accountId && !args.connectionId
    ? [getConnectionForAccount(config, args.accountId)]
    : args.connectionId
      ? [getConnection(config, args.connectionId)]
      : getAllConnections(config);

  // One request per connection: the investments API returns every position on
  // the connection at once. Connections without an investments API are skipped
  // when scanning all, and an error when asked for by name.
  const perConnection = await Promise.all(
    connections.map(async (conn) => {
      const provider = getProvider(conn.provider);
      if (!provider.getHoldings) {
        if (explicit) {
          throw new Error(`Provider "${conn.provider}" does not support investment holdings`);
        }
        return [];
      }

      const cacheKey = `hold:${conn.id}:${args.accountId ?? "*"}`;
      const cached = cache.get<Holding[]>(cacheKey);
      if (cached) return cached;

      const holdings = await provider.getHoldings(
        conn.config,
        args.accountId ? [args.accountId] : undefined,
      );
      cache.set(cacheKey, holdings, TTL.HOLDINGS);
      return holdings;
    }),
  );

  return perConnection.flat();
}
