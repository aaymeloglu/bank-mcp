import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config.js", () => {
  const conns = [
    { id: "a", provider: "mock", label: "A", config: {} },
    { id: "b", provider: "mock", label: "B", config: {} },
  ];
  return {
    loadConfig: vi.fn().mockReturnValue({ version: 1, connections: conns, defaults: { transactionDays: 90, currency: "USD" } }),
    getConnection: vi.fn((_cfg: unknown, id: string) => conns.find((c) => c.id === id)),
    getAllConnections: vi.fn().mockReturnValue(conns),
    getConnectionForAccount: vi.fn().mockReturnValue(conns[0]),
  };
});

import { getBalance } from "../../../src/tools/get-balance.js";
import { getProvider } from "../../../src/providers/registry.js";
import { cache } from "../../../src/utils/cache.js";

describe("getBalance", () => {
  beforeEach(() => cache.clear());

  it("returns balances for every account of every connection, in connection/account order", async () => {
    const provider = getProvider("mock");
    const accounts = await provider.listAccounts({});
    const balances = await getBalance({});
    const expectedIds = accounts.map((a) => a.uid);
    // Two connections, same mock accounts each: order is a's accounts then b's.
    const seen = balances.map((b) => b.accountId);
    expect(new Set(seen)).toEqual(new Set(expectedIds));
    expect(seen.length).toBeGreaterThanOrEqual(expectedIds.length * 2);
    for (const b of balances) expect(typeof b.amount).toBe("number");
  });

  it("falls back to concurrent per-account fetches for providers without getBalances", async () => {
    const provider = getProvider("mock");
    let inFlight = 0;
    let maxInFlight = 0;
    const original = provider.getBalance.bind(provider);
    const spy = vi.spyOn(provider, "getBalance").mockImplementation(async (cfg, id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return original(cfg, id);
    });
    await getBalance({ connectionId: "a" });
    spy.mockRestore();
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
