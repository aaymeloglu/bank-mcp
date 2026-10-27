import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config.js", () => {
  const conns = [{ id: "a", provider: "mock", label: "A", config: {} }];
  return {
    loadConfig: vi.fn().mockReturnValue({ version: 1, connections: conns, defaults: { transactionDays: 90, currency: "USD" } }),
    getConnection: vi.fn((_cfg: unknown, id: string) => conns.find((c) => c.id === id)),
    getAllConnections: vi.fn().mockReturnValue(conns),
    getConnectionForAccount: vi.fn().mockReturnValue(conns[0]),
  };
});

import { getLiabilities } from "../../../src/tools/get-liabilities.js";
import { connectionStatus } from "../../../src/tools/connection-status.js";
import { cache } from "../../../src/utils/cache.js";

describe("tools with a provider that has neither API", () => {
  beforeEach(() => cache.clear());

  it("get_liabilities skips when scanning, errors when targeted", async () => {
    expect(await getLiabilities({})).toEqual([]);
    await expect(getLiabilities({ connectionId: "a" })).rejects.toThrow("does not support");
  });

  it("connection_status still lists the connection", async () => {
    expect(await connectionStatus({})).toEqual([
      expect.objectContaining({ connectionId: "a", provider: "mock", ok: true }),
    ]);
  });
});
