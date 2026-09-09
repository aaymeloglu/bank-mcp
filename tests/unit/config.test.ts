import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn() };
});

import { readFileSync } from "node:fs";
import { loadConfig, normalizeConfig } from "../../src/config.js";

const plaidConn = {
  id: "wells-fargo",
  provider: "plaid",
  label: "Wells Fargo",
  config: { accessToken: "x", accounts: [] },
};

describe("normalizeConfig", () => {
  it("fills defaults when a config file omits them", () => {
    const cfg = normalizeConfig({ version: 1, connections: [plaidConn] });
    expect(cfg.defaults).toEqual({ transactionDays: 90, currency: "PLN" });
    expect(cfg.connections).toEqual([plaidConn]);
  });

  it("keeps explicit defaults and fills only the missing keys", () => {
    const cfg = normalizeConfig({ version: 1, connections: [], defaults: { currency: "USD" } as never });
    expect(cfg.defaults).toEqual({ transactionDays: 90, currency: "USD" });
  });

  it("tolerates empty or malformed input", () => {
    expect(normalizeConfig(null).connections).toEqual([]);
    expect(normalizeConfig({ connections: "nope" as never }).connections).toEqual([]);
  });
});

describe("loadConfig", () => {
  afterEach(() => {
    vi.mocked(readFileSync).mockReset();
    delete process.env.BANK_MCP_MOCK;
  });

  it("returns a usable config for a file written without `defaults` (Plaid migration shape)", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: 1, connections: [plaidConn] }));
    const cfg = loadConfig();
    expect(cfg.defaults.transactionDays).toBe(90);
    expect(cfg.connections[0].id).toBe("wells-fargo");
  });

  it("falls back to an empty default config when the file is missing", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const cfg = loadConfig();
    expect(cfg.connections).toEqual([]);
    expect(cfg.defaults.transactionDays).toBe(90);
  });
});
