import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlaidProvider, fixedIncomeTerms } from "../../../src/providers/plaid/index.js";

vi.mock("../../../src/utils/http.js", () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from "../../../src/utils/http.js";

const mockedFetch = vi.mocked(httpFetch);

import holdingsFixture from "../../fixtures/plaid/holdings.json";

const TEST_CONFIG = {
  clientId: "plaid_client_test",
  secret: "plaid_secret_test",
  accessToken: "access-sandbox-test123",
  environment: "sandbox",
};

function security(name: string) {
  return {
    security_id: "s",
    name,
    ticker_symbol: null,
    cusip: null,
    type: "fixed income",
    is_cash_equivalent: false,
    close_price: null,
    iso_currency_code: "USD",
    fixed_income: null,
  };
}

function invTx(id: string, overrides: Record<string, unknown> = {}) {
  return {
    investment_transaction_id: id,
    account_id: "plaid_acc_brokerage",
    security_id: "sec_muni",
    date: "2026-09-22",
    name: "Bought EXAMPLE CITY WTR REV",
    quantity: 50000,
    amount: 51890.42,
    price: 103.78,
    fees: 0,
    type: "buy",
    subtype: "buy",
    iso_currency_code: "USD",
    ...overrides,
  };
}

describe("PlaidProvider investments", () => {
  const provider = new PlaidProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getHoldings", () => {
    it("joins holdings to securities and normalizes fields", async () => {
      mockedFetch.mockResolvedValueOnce(holdingsFixture);
      const holdings = await provider.getHoldings(TEST_CONFIG);

      expect(holdings).toHaveLength(3);
      expect(holdings[0]).toMatchObject({
        accountId: "plaid_acc_brokerage",
        name: expect.stringContaining("EXAMPLE CITY WTR REV"),
        type: "fixed income",
        isCashEquivalent: false,
        quantity: 250000,
        price: 101.25,
        value: 253125,
        costBasis: 262500,
        fixedIncome: {
          couponRate: 5,
          maturityDate: "2045-11-15",
          callDate: "2035-11-15",
          callPrice: 100,
        },
      });
    });

    it("marks cash and omits empty cost basis and bond terms", async () => {
      mockedFetch.mockResolvedValueOnce(holdingsFixture);
      const [, cash] = await provider.getHoldings(TEST_CONFIG);

      expect(cash.isCashEquivalent).toBe(true);
      expect(cash.ticker).toBe("CUR:USD");
      expect(cash.costBasis).toBeUndefined();
      expect(cash.fixedIncome).toBeUndefined();
    });

    it("prefers Plaid's structured fixed_income over the description", async () => {
      mockedFetch.mockResolvedValueOnce(holdingsFixture);
      const [, , tsy] = await provider.getHoldings(TEST_CONFIG);

      expect(tsy.fixedIncome).toEqual({ couponRate: 3.5, maturityDate: "2029-09-30" });
    });

    it("passes account_ids when filtering", async () => {
      mockedFetch.mockResolvedValueOnce(holdingsFixture);
      await provider.getHoldings(TEST_CONFIG, ["plaid_acc_brokerage"]);

      expect(mockedFetch).toHaveBeenCalledWith(
        "https://sandbox.plaid.com/investments/holdings/get",
        expect.objectContaining({
          body: expect.stringContaining('"account_ids":["plaid_acc_brokerage"]'),
        }),
      );
    });
  });

  describe("fixedIncomeTerms", () => {
    it.each([
      [
        "NEW YORK ST DORM AUTH Cpn 5.000% Due 03/15/45 Dtd 12/17/24 Fc 03/15/25 Call 03/15/35 @ 100.000",
        { couponRate: 5, maturityDate: "2045-03-15", callDate: "2035-03-15", callPrice: 100 },
      ],
      [
        "Hampton Roads Santn Dist Va Wastewater Rev, Bds, Ser 2024B 5% Due 07/01/2045 Callable 07/01/2034 @ 100",
        { couponRate: 5, maturityDate: "2045-07-01", callDate: "2034-07-01", callPrice: 100 },
      ],
      ["Jefferson Cnty Ala 5%46Warr Due 02/01/46", { couponRate: 5, maturityDate: "2046-02-01" }],
      [
        "Orlando Fla Utils Commn Util Sys Rev Bds Ser a Jun23 05.000%Oct01 2048 Callable-May Affect Yiel",
        { couponRate: 5, maturityDate: "2048-10-01" },
      ],
    ])("parses %s", (name, expected) => {
      expect(fixedIncomeTerms(security(name))).toEqual(expected);
    });

    it("returns undefined when the description has no terms", () => {
      expect(fixedIncomeTerms(security("Washington St"))).toBeUndefined();
    });
  });

  describe("listInvestmentTransactions", () => {
    it("flips the sign so cash out is negative and attaches security info", async () => {
      mockedFetch.mockResolvedValueOnce({
        investment_transactions: [
          invTx("t1"),
          invTx("t2", { type: "cash", subtype: "interest", amount: -12500, security_id: null }),
        ],
        securities: holdingsFixture.securities,
        total_investment_transactions: 2,
        accounts: [],
        item: {},
        request_id: "r",
      });

      const [buy, interest] = await provider.listInvestmentTransactions(TEST_CONFIG, undefined, {
        dateFrom: "2026-01-01",
        dateTo: "2026-10-27",
      });

      expect(buy).toMatchObject({ type: "buy", amount: -51890.42, securityName: expect.stringContaining("EXAMPLE CITY") });
      expect(interest).toMatchObject({ type: "cash", subtype: "interest", amount: 12500 });
      expect(interest.securityId).toBeUndefined();
    });

    it("paginates by offset until total is reached", async () => {
      const page = (ids: string[]) => ({
        investment_transactions: ids.map((id) => invTx(id)),
        securities: [],
        total_investment_transactions: 3,
        accounts: [],
        item: {},
        request_id: "r",
      });
      mockedFetch.mockResolvedValueOnce(page(["a", "b"])).mockResolvedValueOnce(page(["c"]));

      const txs = await provider.listInvestmentTransactions(TEST_CONFIG, ["plaid_acc_brokerage"]);

      expect(txs.map((t) => t.id)).toEqual(["a", "b", "c"]);
      expect(mockedFetch).toHaveBeenCalledTimes(2);
      expect(mockedFetch.mock.calls[1][1]).toMatchObject({ body: expect.stringContaining('"offset":2') });
    });
  });
});
