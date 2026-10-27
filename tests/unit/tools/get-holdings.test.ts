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

import { getHoldings } from "../../../src/tools/get-holdings.js";
import { listInvestmentTransactions } from "../../../src/tools/list-investment-transactions.js";
import { cache } from "../../../src/utils/cache.js";

describe("investment tools with a provider that has no investments API", () => {
  beforeEach(() => cache.clear());

  it("skip the connection when scanning all", async () => {
    expect(await getHoldings({})).toEqual([]);
    expect(await listInvestmentTransactions({})).toEqual([]);
  });

  it("error when the connection is named", async () => {
    await expect(getHoldings({ connectionId: "a" })).rejects.toThrow("does not support");
    await expect(listInvestmentTransactions({ accountId: "x" })).rejects.toThrow("does not support");
  });
});
