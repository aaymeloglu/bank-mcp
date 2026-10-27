import { z } from "zod";
import { loadConfig, getConnection, getConnectionForAccount, getAllConnections } from "../config.js";
import { getProvider } from "../providers/registry.js";
import { cache, TTL } from "../utils/cache.js";
import type { Liability } from "../types.js";

export const getLiabilitiesSchema = z.object({
  connectionId: z.string().optional(),
  accountId: z
    .string()
    .optional()
    .describe("Account UID. If omitted, returns every credit card and loan."),
});

export async function getLiabilities(
  args: z.infer<typeof getLiabilitiesSchema>,
): Promise<Liability[]> {
  const config = loadConfig();

  const explicit = Boolean(args.accountId || args.connectionId);
  const connections = args.accountId && !args.connectionId
    ? [getConnectionForAccount(config, args.accountId)]
    : args.connectionId
      ? [getConnection(config, args.connectionId)]
      : getAllConnections(config);

  // Connections without a liabilities API are skipped when scanning all, and an
  // error when asked for by name.
  const perConnection = await Promise.all(
    connections.map(async (conn) => {
      const provider = getProvider(conn.provider);
      if (!provider.getLiabilities) {
        if (explicit) {
          throw new Error(`Provider "${conn.provider}" does not support liabilities`);
        }
        return [];
      }

      const cacheKey = `liab:${conn.id}:${args.accountId ?? "*"}`;
      const cached = cache.get<Liability[]>(cacheKey);
      if (cached) return cached;

      const liabilities = await provider.getLiabilities(
        conn.config,
        args.accountId ? [args.accountId] : undefined,
      );
      cache.set(cacheKey, liabilities, TTL.LIABILITIES);
      return liabilities;
    }),
  );

  return perConnection.flat();
}
