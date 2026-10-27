import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlaidProvider } from "../../../src/providers/plaid/index.js";

vi.mock("../../../src/utils/http.js", () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from "../../../src/utils/http.js";

const mockedFetch = vi.mocked(httpFetch);

import liabilitiesFixture from "../../fixtures/plaid/liabilities.json";

const TEST_CONFIG = {
  clientId: "plaid_client_test",
  secret: "plaid_secret_test",
  accessToken: "access-sandbox-test123",
  environment: "sandbox",
};

function plaidError(code: string): Error {
  return new Error(
    `HTTP 400 Bad Request: {"display_message":null,"error_code":"${code}","error_message":"x","error_type":"ITEM_ERROR"}`,
  );
}

describe("PlaidProvider liabilities and status", () => {
  const provider = new PlaidProvider();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getLiabilities", () => {
    it("normalizes cards, loans and student loans", async () => {
      mockedFetch.mockResolvedValueOnce(liabilitiesFixture);
      const [card, auto, student] = await provider.getLiabilities(TEST_CONFIG);

      expect(card).toEqual({
        accountId: "plaid_acc_card",
        kind: "credit",
        nextPaymentDueDate: "2026-11-07",
        nextPaymentAmount: 40,
        lastPaymentDate: "2026-10-03",
        lastPaymentAmount: 1834.12,
        isOverdue: false,
        lastStatementDate: "2026-10-12",
        lastStatementBalance: 2210.55,
        aprs: [
          { type: "purchase_apr", percentage: 24.49 },
          { type: "cash_apr", percentage: 29.49 },
        ],
      });
      expect(auto).toMatchObject({
        kind: "loan",
        nextPaymentAmount: 612.3,
        interestRate: 5.49,
        principalBalance: 17950.4,
        maturityDate: "2029-03-15",
      });
      expect(auto.payoffAmount).toBeUndefined();
      expect(student).toMatchObject({
        kind: "student",
        nextPaymentAmount: 210,
        interestRate: 4.5,
        maturityDate: "2032-06-01",
      });
    });

    it("never returns account numbers", async () => {
      mockedFetch.mockResolvedValueOnce(liabilitiesFixture);
      const result = await provider.getLiabilities(TEST_CONFIG);
      expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_APPEAR");
    });

    it.each(["NO_LIABILITY_ACCOUNTS", "PRODUCTS_NOT_SUPPORTED"])("treats %s as empty", async (code) => {
      mockedFetch.mockRejectedValueOnce(plaidError(code));
      await expect(provider.getLiabilities(TEST_CONFIG)).resolves.toEqual([]);
    });

    it("rethrows other errors", async () => {
      mockedFetch.mockRejectedValueOnce(plaidError("ITEM_LOGIN_REQUIRED"));
      await expect(provider.getLiabilities(TEST_CONFIG)).rejects.toThrow("ITEM_LOGIN_REQUIRED");
    });
  });

  describe("getConnectionStatus", () => {
    const itemResponse = (error: unknown) => ({
      item: {
        item_id: "item_1",
        institution_name: "Example Bank",
        error,
        consent_expiration_time: null,
      },
      status: {
        transactions: {
          last_successful_update: "2026-10-27T10:00:00Z",
          last_failed_update: "2026-10-20T10:00:00Z",
        },
        investments: null,
        last_webhook: null,
      },
      request_id: "r",
    });

    it("reports a healthy item with refresh times", async () => {
      mockedFetch.mockResolvedValueOnce(itemResponse(null));
      await expect(provider.getConnectionStatus(TEST_CONFIG)).resolves.toEqual({
        institution: "Example Bank",
        ok: true,
        errorCode: undefined,
        errorMessage: undefined,
        lastSuccessfulUpdate: { transactions: "2026-10-27T10:00:00Z" },
        lastFailedUpdate: { transactions: "2026-10-20T10:00:00Z" },
        consentExpiresAt: undefined,
      });
    });

    it("reports an item that needs re-login", async () => {
      mockedFetch.mockResolvedValueOnce(
        itemResponse({ error_code: "ITEM_LOGIN_REQUIRED", error_message: "login details changed" }),
      );
      const status = await provider.getConnectionStatus(TEST_CONFIG);
      expect(status).toMatchObject({ ok: false, errorCode: "ITEM_LOGIN_REQUIRED" });
    });

    it("reports a failed call instead of throwing", async () => {
      mockedFetch.mockRejectedValueOnce(plaidError("INVALID_ACCESS_TOKEN"));
      const status = await provider.getConnectionStatus(TEST_CONFIG);
      expect(status).toMatchObject({ ok: false, errorCode: "INVALID_ACCESS_TOKEN" });
    });
  });
});
