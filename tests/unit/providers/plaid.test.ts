import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlaidProvider, resetTransactionSync } from "../../../src/providers/plaid/index.js";

// Mock the HTTP layer
vi.mock("../../../src/utils/http.js", () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from "../../../src/utils/http.js";

const mockedFetch = vi.mocked(httpFetch);

// Fixtures
import accountsFixture from "../../fixtures/plaid/accounts.json";
import transactionsFixture from "../../fixtures/plaid/transactions.json";

const TEST_CONFIG = {
  clientId: "plaid_client_test",
  secret: "plaid_secret_test",
  accessToken: "access-sandbox-test123",
  environment: "sandbox",
};

describe("PlaidProvider", () => {
  const provider = new PlaidProvider();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetTransactionSync();
  });

  describe("validateConfig", () => {
    it("accepts valid config", () => {
      expect(() => provider.validateConfig(TEST_CONFIG)).not.toThrow();
    });

    it("defaults to sandbox environment", () => {
      expect(() =>
        provider.validateConfig({
          clientId: "c",
          secret: "s",
          accessToken: "a",
        }),
      ).not.toThrow();
    });

    it("rejects missing clientId", () => {
      expect(() =>
        provider.validateConfig({ secret: "s", accessToken: "a" }),
      ).toThrow("clientId");
    });

    it("rejects invalid environment", () => {
      expect(() =>
        provider.validateConfig({
          ...TEST_CONFIG,
          environment: "staging",
        }),
      ).toThrow("staging");
    });
  });

  describe("listAccounts", () => {
    it("returns all accounts with correct fields", async () => {
      mockedFetch.mockResolvedValueOnce(accountsFixture);

      const accounts = await provider.listAccounts(TEST_CONFIG);

      expect(accounts).toHaveLength(3);
      expect(accounts[0].uid).toBe("plaid_acc_checking");
      expect(accounts[0].name).toBe("Gold Standard 0% Interest Checking");
      expect(accounts[0].iban).toBe("****1234");
      expect(accounts[0].currency).toBe("USD");
    });

    it("prefers official_name over name", async () => {
      mockedFetch.mockResolvedValueOnce(accountsFixture);

      const accounts = await provider.listAccounts(TEST_CONFIG);

      // First account has official_name
      expect(accounts[0].name).toBe("Gold Standard 0% Interest Checking");
      // Third account has null official_name — falls back to name
      expect(accounts[2].name).toBe("Plaid Credit Card");
    });

    it("posts to sandbox URL with correct auth headers", async () => {
      mockedFetch.mockResolvedValueOnce(accountsFixture);

      await provider.listAccounts(TEST_CONFIG);

      expect(mockedFetch).toHaveBeenCalledWith(
        "https://sandbox.plaid.com/accounts/get",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "PLAID-CLIENT-ID": "plaid_client_test",
            "PLAID-SECRET": "plaid_secret_test",
          }),
        }),
      );
    });
  });

  describe("listTransactions", () => {
    // Fixture dates are Feb 2026; ask for that window explicitly.
    const FEB = { dateFrom: "2026-02-01", dateTo: "2026-02-28" };
    const fixtureTxs = transactionsFixture.transactions;

    function syncPage(
      added: unknown[],
      opts: { modified?: unknown[]; removed?: string[]; next_cursor?: string; has_more?: boolean } = {},
    ) {
      return {
        added,
        modified: opts.modified ?? [],
        removed: (opts.removed ?? []).map((transaction_id) => ({ transaction_id })),
        next_cursor: opts.next_cursor ?? "cursor-1",
        has_more: opts.has_more ?? false,
        request_id: "r",
      };
    }

    function bodyOf(call: number) {
      return JSON.parse((mockedFetch.mock.calls[call][1] as { body: string }).body);
    }

    it("flips Plaid amount signs (positive → negative for debits)", async () => {
      mockedFetch.mockResolvedValueOnce(syncPage(fixtureTxs));

      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);

      // Burger King: Plaid amount=28.34 (positive = money out) → our amount=-28.34
      const bk = txs.find((t) => t.id === "plaid_tx_001");
      expect(bk).toBeDefined();
      expect(bk!.amount).toBe(-28.34);
      expect(bk!.type).toBe("debit");
    });

    it("flips income correctly (negative → positive)", async () => {
      mockedFetch.mockResolvedValueOnce(syncPage(fixtureTxs));

      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);

      // Payroll: Plaid amount=-3500 (negative = money in) → our amount=3500
      const salary = txs.find((t) => t.id === "plaid_tx_002");
      expect(salary).toBeDefined();
      expect(salary!.amount).toBe(3500);
      expect(salary!.type).toBe("credit");
    });

    it("uses personal_finance_category.detailed for category", async () => {
      mockedFetch.mockResolvedValueOnce(syncPage(fixtureTxs));

      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);

      const bk = txs.find((t) => t.id === "plaid_tx_001");
      expect(bk!.category).toBe("FOOD_AND_DRINK_FAST_FOOD");

      const netflix = txs.find((t) => t.id === "plaid_tx_003");
      expect(netflix!.category).toBe("ENTERTAINMENT_TV_AND_MOVIES");
    });

    it("extracts merchant from counterparties when merchant_name is null", async () => {
      mockedFetch.mockResolvedValueOnce(syncPage(fixtureTxs));

      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);

      // Burger King: merchant_name is "Burger King" directly
      const bk = txs.find((t) => t.id === "plaid_tx_001");
      expect(bk!.merchantName).toBe("Burger King");

      // Salary: no merchant_name, counterparty type is "financial_institution" not "merchant"
      const salary = txs.find((t) => t.id === "plaid_tx_002");
      expect(salary!.merchantName).toBeUndefined();
      expect(salary!.description).toBe("TECHCORP INC PAYROLL");
    });

    it("filters to the account and date range locally, newest first", async () => {
      const other = { ...fixtureTxs[0], transaction_id: "other_acct", account_id: "plaid_acc_savings" };
      const old = { ...fixtureTxs[0], transaction_id: "old", date: "2025-12-01" };
      mockedFetch.mockResolvedValueOnce(syncPage([...fixtureTxs, other, old]));

      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);

      expect(txs.map((t) => t.id)).toEqual([
        "plaid_tx_001",
        "plaid_tx_002",
        "plaid_tx_003",
        "plaid_tx_004",
        "plaid_tx_005",
      ]);
    });

    it("follows has_more with next_cursor, starting with no cursor", async () => {
      mockedFetch
        .mockResolvedValueOnce(syncPage(fixtureTxs.slice(0, 3), { next_cursor: "c1", has_more: true }))
        .mockResolvedValueOnce(syncPage(fixtureTxs.slice(3), { next_cursor: "c2" }));

      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);

      expect(txs).toHaveLength(5);
      expect(mockedFetch).toHaveBeenCalledTimes(2);
      expect(String(mockedFetch.mock.calls[0][0])).toContain("/transactions/sync");
      expect(bodyOf(0).cursor).toBeUndefined();
      expect(bodyOf(1).cursor).toBe("c1");
    });

    it("applies modified and removed on the next sync, sending the saved cursor", async () => {
      vi.useFakeTimers();
      mockedFetch.mockResolvedValueOnce(syncPage(fixtureTxs, { next_cursor: "c1" }));
      await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);

      vi.advanceTimersByTime(61_000);
      const renamed = { ...fixtureTxs[2], name: "NETFLIX RENAMED", merchant_name: null, counterparties: [] };
      mockedFetch.mockResolvedValueOnce(
        syncPage([], { modified: [renamed], removed: ["plaid_tx_001"], next_cursor: "c2" }),
      );
      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);

      expect(bodyOf(1).cursor).toBe("c1");
      expect(txs.find((t) => t.id === "plaid_tx_001")).toBeUndefined();
      expect(txs.find((t) => t.id === "plaid_tx_003")!.description).toBe("NETFLIX RENAMED");
      expect(txs).toHaveLength(4);
    });

    it("reuses a sync from the last minute instead of calling Plaid again", async () => {
      mockedFetch.mockResolvedValueOnce(syncPage(fixtureTxs));

      await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);
      await provider.listTransactions(TEST_CONFIG, "plaid_acc_savings", FEB);

      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it("restarts pagination from the original cursor when data changes mid-sync", async () => {
      mockedFetch
        .mockResolvedValueOnce(syncPage(fixtureTxs.slice(0, 2), { next_cursor: "c1", has_more: true }))
        .mockRejectedValueOnce(
          new Error(
            'HTTP 400 Bad Request: {"error_code":"TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION","error_type":"TRANSACTIONS_ERROR"}',
          ),
        )
        .mockResolvedValueOnce(syncPage(fixtureTxs, { next_cursor: "c9" }));

      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", FEB);

      expect(txs).toHaveLength(5);
      expect(mockedFetch).toHaveBeenCalledTimes(3);
      expect(bodyOf(2).cursor).toBeUndefined();
    });

    it("filters by type", async () => {
      mockedFetch.mockResolvedValueOnce(syncPage(fixtureTxs));

      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", {
        ...FEB,
        type: "credit",
      });

      expect(txs).toHaveLength(1);
      expect(txs[0].amount).toBe(3500);
    });

    it("filters by amount range", async () => {
      mockedFetch.mockResolvedValueOnce(syncPage(fixtureTxs));

      const txs = await provider.listTransactions(TEST_CONFIG, "plaid_acc_checking", {
        ...FEB,
        amountMin: 20,
        amountMax: 100,
      });

      // Should include: Burger King (28.34), Whole Foods (89.50)
      // Should exclude: salary (3500), Netflix (15.99), transfer (500)
      expect(txs).toHaveLength(2);
      for (const t of txs) {
        expect(Math.abs(t.amount)).toBeGreaterThanOrEqual(20);
        expect(Math.abs(t.amount)).toBeLessThanOrEqual(100);
      }
    });
  });

  describe("getBalance", () => {
    it("returns current and available balances", async () => {
      mockedFetch.mockResolvedValueOnce(accountsFixture);

      const balances = await provider.getBalance(
        TEST_CONFIG,
        "plaid_acc_checking",
      );

      expect(balances.length).toBeGreaterThanOrEqual(2);

      const current = balances.find((b) => b.type === "current");
      expect(current).toBeDefined();
      expect(current!.amount).toBe(5400);

      const available = balances.find((b) => b.type === "available");
      expect(available).toBeDefined();
      expect(available!.amount).toBe(5250);
    });
  });

  describe("getBalances", () => {
    it("fetches every account of the item in a single request when no ids are given", async () => {
      mockedFetch.mockResolvedValueOnce(accountsFixture);

      const balances = await provider.getBalances(TEST_CONFIG);

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockedFetch.mock.calls[0];
      expect(String(url)).toContain("/accounts/balance/get");
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
      expect(body.options?.account_ids).toBeUndefined();
      const ids = new Set(balances.map((b) => b.accountId));
      expect(ids.size).toBe(accountsFixture.accounts.length);
    });

    it("filters to the requested account ids", async () => {
      mockedFetch.mockResolvedValueOnce(accountsFixture);
      await provider.getBalances(TEST_CONFIG, ["plaid_acc_checking"]);
      const [, init] = mockedFetch.mock.calls[0];
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
      expect(body.options.account_ids).toEqual(["plaid_acc_checking"]);
    });
  });

  describe("getConfigSchema", () => {
    it("returns all required fields including environment", () => {
      const schema = provider.getConfigSchema();
      const names = schema.map((f) => f.name);
      expect(names).toContain("clientId");
      expect(names).toContain("secret");
      expect(names).toContain("accessToken");
      expect(names).toContain("environment");

      const envField = schema.find((f) => f.name === "environment");
      expect(envField!.type).toBe("select");
      expect(envField!.options).toContain("sandbox");
      expect(envField!.options).toContain("production");
      expect(envField!.default).toBe("sandbox");
    });
  });
});
