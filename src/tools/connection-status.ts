import { z } from "zod";
import { loadConfig, getConnection, getAllConnections } from "../config.js";
import { getProvider } from "../providers/registry.js";
import type { ConnectionStatus } from "../types.js";

export const connectionStatusSchema = z.object({
  connectionId: z
    .string()
    .optional()
    .describe("Connection ID. If omitted, checks every connection."),
});

/**
 * Never cached: the point is to see the current state. Providers without a
 * status API report ok with no detail rather than being left out.
 */
export async function connectionStatus(
  args: z.infer<typeof connectionStatusSchema>,
): Promise<ConnectionStatus[]> {
  const config = loadConfig();
  const connections = args.connectionId
    ? [getConnection(config, args.connectionId)]
    : getAllConnections(config);

  return Promise.all(
    connections.map(async (conn) => {
      const provider = getProvider(conn.provider);
      const base = { connectionId: conn.id, provider: conn.provider };
      if (!provider.getConnectionStatus) {
        return { ...base, ok: true, errorMessage: "Provider has no status API; not checked" };
      }
      return { ...base, ...(await provider.getConnectionStatus(conn.config)) };
    }),
  );
}
