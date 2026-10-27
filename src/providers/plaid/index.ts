import { BankProvider } from "../base.js";
import { httpFetch } from "../../utils/http.js";
import type {
  BankAccount,
  Transaction,
  Balance,
  TransactionFilter,
  ConfigField,
  Holding,
  InvestmentTransaction,
  InvestmentTransactionFilter,
  FixedIncomeTerms,
  Liability,
  ConnectionStatus,
} from "../../types.js";

const ENVIRONMENTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

interface PlaidConfig {
  clientId: string;
  secret: string;
  accessToken: string;
  environment: string;
}

function parseConfig(raw: Record<string, unknown>): PlaidConfig {
  const clientId = raw.clientId as string;
  const secret = raw.secret as string;
  const accessToken = raw.accessToken as string;
  const environment = (raw.environment as string) || "sandbox";
  if (!clientId || !secret || !accessToken) {
    throw new Error(
      "Plaid config requires: clientId, secret, accessToken",
    );
  }
  if (!ENVIRONMENTS[environment]) {
    throw new Error(
      `Invalid Plaid environment "${environment}". Use: sandbox, development, production`,
    );
  }
  return { clientId, secret, accessToken, environment };
}

/**
 * All Plaid endpoints are POST with JSON body containing credentials.
 */
async function plaidPost(
  config: PlaidConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = ENVIRONMENTS[config.environment];
  return httpFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PLAID-CLIENT-ID": config.clientId,
      "PLAID-SECRET": config.secret,
    },
    body: JSON.stringify({
      access_token: config.accessToken,
      ...body,
    }),
    timeoutMs: 30000,
    retries: 2,
  });
}

export class PlaidProvider extends BankProvider {
  readonly name = "plaid";
  readonly displayName = "Plaid (US/CA/EU)";

  validateConfig(config: Record<string, unknown>): void {
    parseConfig(config);
  }

  getConfigSchema(): ConfigField[] {
    return [
      {
        name: "clientId",
        label: "Client ID",
        type: "string",
        required: true,
      },
      {
        name: "secret",
        label: "Secret",
        type: "string",
        required: true,
        secret: true,
      },
      {
        name: "accessToken",
        label: "Access token (from Plaid Link)",
        type: "string",
        required: true,
        secret: true,
      },
      {
        name: "environment",
        label: "Environment",
        type: "select",
        required: true,
        options: ["sandbox", "development", "production"],
        default: "sandbox",
      },
    ];
  }

  async listAccounts(config: Record<string, unknown>): Promise<BankAccount[]> {
    const pc = parseConfig(config);

    const data = (await plaidPost(pc, "/accounts/get", {})) as PlaidAccountsResponse;

    return data.accounts.map((a) => ({
      uid: a.account_id,
      iban: a.mask ? `****${a.mask}` : a.account_id,
      name: a.official_name || a.name,
      currency: a.balances?.iso_currency_code || "USD",
      connectionId: "",
    }));
  }

  async listTransactions(
    config: Record<string, unknown>,
    accountId: string,
    filter?: TransactionFilter,
  ): Promise<Transaction[]> {
    const pc = parseConfig(config);

    const startDate = filter?.dateFrom || defaultDateFrom(90);
    const endDate = filter?.dateTo || today();

    const allTx: Transaction[] = [];
    let offset = 0;
    const pageSize = 500;

    // Offset-based pagination — loop until we have all transactions
    do {
      const data = (await plaidPost(pc, "/transactions/get", {
        start_date: startDate,
        end_date: endDate,
        options: {
          account_ids: [accountId],
          count: pageSize,
          offset,
          include_personal_finance_category: true,
        },
      })) as PlaidTransactionsResponse;

      for (const raw of data.transactions) {
        allTx.push(normalizeTransaction(raw));
      }

      offset += data.transactions.length;
      if (offset >= data.total_transactions) break;
    } while (true);

    // Apply local filters
    let filtered = allTx;
    if (filter?.amountMin !== undefined) {
      filtered = filtered.filter((t) => Math.abs(t.amount) >= filter.amountMin!);
    }
    if (filter?.amountMax !== undefined) {
      filtered = filtered.filter((t) => Math.abs(t.amount) <= filter.amountMax!);
    }
    if (filter?.type) {
      filtered = filtered.filter((t) => t.type === filter.type);
    }
    if (filter?.limit) {
      filtered = filtered.slice(0, filter.limit);
    }

    return filtered;
  }

  async getBalance(
    config: Record<string, unknown>,
    accountId: string,
  ): Promise<Balance[]> {
    return this.getBalances(config, [accountId]);
  }

  /**
   * One /accounts/balance/get per connection. Plaid rate-limits this endpoint per
   * item (BALANCE_LIMIT), so batching matters as much as speed.
   */
  async getBalances(
    config: Record<string, unknown>,
    accountIds?: string[],
  ): Promise<Balance[]> {
    const pc = parseConfig(config);

    const body: Record<string, unknown> = accountIds?.length
      ? { options: { account_ids: accountIds } }
      : {};
    const data = (await plaidPost(pc, "/accounts/balance/get", body)) as PlaidAccountsResponse;

    const balances: Balance[] = [];
    for (const acc of data.accounts) {
      const currency = acc.balances?.iso_currency_code || "USD";

      if (acc.balances?.current !== null && acc.balances?.current !== undefined) {
        balances.push({
          accountId: acc.account_id,
          amount: acc.balances.current,
          currency,
          type: "current",
        });
      }
      if (acc.balances?.available !== null && acc.balances?.available !== undefined) {
        balances.push({
          accountId: acc.account_id,
          amount: acc.balances.available,
          currency,
          type: "available",
        });
      }
    }

    return balances;
  }

  /**
   * /investments/holdings/get returns every position on the item in one call;
   * filter to `accountIds` server-side when given.
   */
  async getHoldings(
    config: Record<string, unknown>,
    accountIds?: string[],
  ): Promise<Holding[]> {
    const pc = parseConfig(config);

    const body: Record<string, unknown> = accountIds?.length
      ? { options: { account_ids: accountIds } }
      : {};
    const data = (await plaidPost(pc, "/investments/holdings/get", body)) as PlaidHoldingsResponse;

    const securities = new Map(data.securities.map((s) => [s.security_id, s]));
    return data.holdings.map((h) => normalizeHolding(h, securities.get(h.security_id)));
  }

  async listInvestmentTransactions(
    config: Record<string, unknown>,
    accountIds: string[] | undefined,
    filter?: InvestmentTransactionFilter,
  ): Promise<InvestmentTransaction[]> {
    const pc = parseConfig(config);

    const startDate = filter?.dateFrom || defaultDateFrom(90);
    const endDate = filter?.dateTo || today();

    const all: InvestmentTransaction[] = [];
    const securities = new Map<string, PlaidSecurity>();
    let offset = 0;
    const pageSize = 500;

    do {
      const data = (await plaidPost(pc, "/investments/transactions/get", {
        start_date: startDate,
        end_date: endDate,
        options: {
          ...(accountIds?.length ? { account_ids: accountIds } : {}),
          count: pageSize,
          offset,
        },
      })) as PlaidInvestmentTransactionsResponse;

      for (const sec of data.securities) securities.set(sec.security_id, sec);
      for (const raw of data.investment_transactions) {
        all.push(
          normalizeInvestmentTransaction(
            raw,
            raw.security_id ? securities.get(raw.security_id) : undefined,
          ),
        );
      }

      offset += data.investment_transactions.length;
      if (data.investment_transactions.length === 0) break;
      if (offset >= data.total_investment_transactions) break;
    } while (true);

    return all;
  }

  /**
   * /liabilities/get. Items with no card or loan accounts (NO_LIABILITY_ACCOUNTS)
   * or at institutions without liabilities data, e.g. brokerages
   * (PRODUCTS_NOT_SUPPORTED), are an empty result, not a failure.
   */
  async getLiabilities(
    config: Record<string, unknown>,
    accountIds?: string[],
  ): Promise<Liability[]> {
    const pc = parseConfig(config);

    const body: Record<string, unknown> = accountIds?.length
      ? { options: { account_ids: accountIds } }
      : {};
    let data: PlaidLiabilitiesResponse;
    try {
      data = (await plaidPost(pc, "/liabilities/get", body)) as PlaidLiabilitiesResponse;
    } catch (err) {
      const code = plaidErrorCode(err);
      if (code === "NO_LIABILITY_ACCOUNTS" || code === "PRODUCTS_NOT_SUPPORTED") return [];
      throw err;
    }

    const l = data.liabilities;
    return [
      ...(l.credit ?? []).map(normalizeCredit),
      ...(l.loan ?? []).map((x) => normalizeLoan(x, "loan")),
      ...(l.mortgage ?? []).map((x) => normalizeLoan(x, "mortgage")),
      ...(l.student ?? []).map((x) => normalizeLoan(x, "student")),
    ];
  }

  /**
   * /item/get. A broken login shows up as item.error on a successful response;
   * a revoked or invalid token makes the call itself fail.
   */
  async getConnectionStatus(
    config: Record<string, unknown>,
  ): Promise<Omit<ConnectionStatus, "connectionId" | "provider">> {
    const pc = parseConfig(config);

    let data: PlaidItemResponse;
    try {
      data = (await plaidPost(pc, "/item/get", {})) as PlaidItemResponse;
    } catch (err) {
      return {
        ok: false,
        errorCode: plaidErrorCode(err),
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    const { item, status } = data;
    const lastSuccessfulUpdate: Record<string, string> = {};
    const lastFailedUpdate: Record<string, string> = {};
    for (const [product, s] of Object.entries(status ?? {})) {
      if (!s || typeof s !== "object") continue;
      if (s.last_successful_update) lastSuccessfulUpdate[product] = s.last_successful_update;
      if (s.last_failed_update) lastFailedUpdate[product] = s.last_failed_update;
    }

    return {
      institution: item.institution_name || undefined,
      ok: !item.error,
      errorCode: item.error?.error_code || undefined,
      errorMessage: item.error?.error_message || undefined,
      ...(Object.keys(lastSuccessfulUpdate).length ? { lastSuccessfulUpdate } : {}),
      ...(Object.keys(lastFailedUpdate).length ? { lastFailedUpdate } : {}),
      consentExpiresAt: item.consent_expiration_time || undefined,
    };
  }

}

// --- Raw Plaid API types ---

interface PlaidAccountsResponse {
  accounts: PlaidAccount[];
  item: Record<string, unknown>;
  request_id: string;
}

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string;
  balances: {
    available: number | null;
    current: number | null;
    iso_currency_code: string | null;
    limit: number | null;
  };
}

interface PlaidTransactionsResponse {
  accounts: PlaidAccount[];
  transactions: PlaidTransaction[];
  total_transactions: number;
  item: Record<string, unknown>;
  request_id: string;
}

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  name: string;
  merchant_name: string | null;
  original_description: string | null;
  pending: boolean;
  payment_channel: string;
  category: string[] | null;
  personal_finance_category: {
    primary: string;
    detailed: string;
    confidence_level: string;
  } | null;
  counterparties?: Array<{
    name: string;
    type: string;
    confidence_level: string;
  }>;
  logo_url: string | null;
  website: string | null;
}

interface PlaidSecurity {
  security_id: string;
  name: string | null;
  ticker_symbol: string | null;
  cusip: string | null;
  type: string | null;
  is_cash_equivalent: boolean | null;
  close_price: number | null;
  iso_currency_code: string | null;
  fixed_income: {
    yield_rate: { percentage: number; type: string | null } | null;
    maturity_date: string | null;
    issue_date: string | null;
    face_value: number | null;
  } | null;
}

interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price: number;
  institution_price_as_of: string | null;
  institution_value: number;
  cost_basis: number | null;
  iso_currency_code: string | null;
}

interface PlaidHoldingsResponse {
  accounts: PlaidAccount[];
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
  item: Record<string, unknown>;
  request_id: string;
}

interface PlaidInvestmentTransaction {
  investment_transaction_id: string;
  account_id: string;
  security_id: string | null;
  date: string;
  name: string;
  quantity: number;
  amount: number;
  price: number;
  fees: number | null;
  type: string;
  subtype: string | null;
  iso_currency_code: string | null;
}

interface PlaidInvestmentTransactionsResponse {
  accounts: PlaidAccount[];
  investment_transactions: PlaidInvestmentTransaction[];
  securities: PlaidSecurity[];
  total_investment_transactions: number;
  item: Record<string, unknown>;
  request_id: string;
}

interface PlaidCreditLiability {
  account_id: string | null;
  aprs: Array<{ apr_type: string | null; apr_percentage: number }> | null;
  is_overdue: boolean | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  last_statement_balance: number | null;
  last_statement_issue_date: string | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
}

/** Loan, mortgage and student liabilities share most fields under slightly different names. */
interface PlaidLoanLiability {
  account_id: string | null;
  interest_rate?: { percentage: number | null; type: string | null } | null;
  interest_rate_percentage?: number | null;
  is_overdue?: boolean | null;
  past_due_amount?: number | null;
  last_payment_amount?: number | null;
  last_payment_date?: string | null;
  next_payment_amount?: number | null;
  next_monthly_payment?: number | null;
  minimum_payment_amount?: number | null;
  next_payment_due_date?: string | null;
  principal_balance?: number | null;
  payoff_amount?: number | null;
  origination_principal_amount?: number | null;
  maturity_date?: string | null;
  expected_payoff_date?: string | null;
  ytd_interest_paid?: number | null;
}

interface PlaidLiabilitiesResponse {
  accounts: PlaidAccount[];
  liabilities: {
    credit: PlaidCreditLiability[] | null;
    loan?: PlaidLoanLiability[] | null;
    mortgage: PlaidLoanLiability[] | null;
    student: PlaidLoanLiability[] | null;
  };
  item: Record<string, unknown>;
  request_id: string;
}

interface PlaidItemResponse {
  item: {
    item_id: string;
    institution_name?: string | null;
    error: { error_code: string; error_message: string } | null;
    consent_expiration_time: string | null;
  };
  status?: Record<
    string,
    { last_successful_update?: string | null; last_failed_update?: string | null } | null
  > | null;
  request_id: string;
}

/**
 * Normalize a Plaid transaction.
 *
 * CRITICAL: Plaid's amount sign is INVERTED from convention.
 * Positive = money leaving the account (expense).
 * Negative = money entering the account (income).
 * We flip this to match our standard (negative = expense).
 *
 * Category: We use personal_finance_category.detailed when available
 * (e.g. "FOOD_AND_DRINK_FAST_FOOD") as it's the most granular.
 * Falls back to primary (e.g. "FOOD_AND_DRINK"), then legacy category array.
 */
function normalizeTransaction(raw: PlaidTransaction): Transaction {
  // Flip sign: Plaid positive = debit (expense), we want negative = expense
  const amount = -raw.amount;
  const isDebit = amount < 0;

  // Best merchant name: merchant_name > counterparty > name
  const merchantName =
    raw.merchant_name ||
    raw.counterparties?.find((c) => c.type === "merchant")?.name ||
    undefined;

  // Best category: detailed PFC > primary PFC > legacy category
  let category: string | undefined;
  if (raw.personal_finance_category?.detailed) {
    category = raw.personal_finance_category.detailed;
  } else if (raw.personal_finance_category?.primary) {
    category = raw.personal_finance_category.primary;
  } else if (raw.category?.length) {
    category = raw.category.join(" > ");
  }

  return {
    id: raw.transaction_id,
    accountId: raw.account_id,
    date: raw.date,
    amount,
    currency: raw.iso_currency_code || "USD",
    description: merchantName || raw.name,
    merchantName,
    category,
    type: isDebit ? "debit" : "credit",
    reference: raw.original_description || raw.name,
    rawData: raw as unknown as Record<string, unknown>,
  };
}

/** Pull Plaid's error_code out of an httpFetch error ("HTTP 400 ...: {json}"). */
function plaidErrorCode(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  return message.match(/"error_code"\s*:\s*"(\w+)"/)?.[1];
}

/** Drop undefined fields so tool output only shows what the bank reported. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  ) as T;
}

function normalizeCredit(c: PlaidCreditLiability): Liability {
  return compact({
    accountId: c.account_id ?? "",
    kind: "credit" as const,
    nextPaymentDueDate: c.next_payment_due_date ?? undefined,
    nextPaymentAmount: c.minimum_payment_amount ?? undefined,
    lastPaymentDate: c.last_payment_date ?? undefined,
    lastPaymentAmount: c.last_payment_amount ?? undefined,
    isOverdue: c.is_overdue ?? undefined,
    lastStatementDate: c.last_statement_issue_date ?? undefined,
    lastStatementBalance: c.last_statement_balance ?? undefined,
    aprs: c.aprs?.map((a) => compact({ type: a.apr_type ?? undefined, percentage: a.apr_percentage })),
  });
}

function normalizeLoan(l: PlaidLoanLiability, kind: "loan" | "mortgage" | "student"): Liability {
  return compact({
    accountId: l.account_id ?? "",
    kind,
    nextPaymentDueDate: l.next_payment_due_date ?? undefined,
    nextPaymentAmount:
      l.next_payment_amount ?? l.next_monthly_payment ?? l.minimum_payment_amount ?? undefined,
    lastPaymentDate: l.last_payment_date ?? undefined,
    lastPaymentAmount: l.last_payment_amount ?? undefined,
    isOverdue: l.is_overdue ?? (l.past_due_amount ? l.past_due_amount > 0 : undefined),
    interestRate: l.interest_rate?.percentage ?? l.interest_rate_percentage ?? undefined,
    principalBalance: l.principal_balance ?? undefined,
    payoffAmount: l.payoff_amount ?? undefined,
    originationPrincipal: l.origination_principal_amount ?? undefined,
    maturityDate: l.maturity_date ?? l.expected_payoff_date ?? undefined,
    ytdInterestPaid: l.ytd_interest_paid ?? undefined,
  });
}

function normalizeHolding(h: PlaidHolding, sec: PlaidSecurity | undefined): Holding {
  const fixedIncome = sec ? fixedIncomeTerms(sec) : undefined;
  return {
    accountId: h.account_id,
    securityId: h.security_id,
    name: sec?.name || h.security_id,
    type: sec?.type || undefined,
    ticker: sec?.ticker_symbol || undefined,
    cusip: sec?.cusip || undefined,
    isCashEquivalent: sec?.is_cash_equivalent ?? false,
    quantity: h.quantity,
    price: h.institution_price,
    priceAsOf: h.institution_price_as_of || undefined,
    value: h.institution_value,
    costBasis: h.cost_basis ?? undefined,
    currency: h.iso_currency_code || sec?.iso_currency_code || "USD",
    ...(fixedIncome ? { fixedIncome } : {}),
  };
}

/**
 * Plaid's investment amount sign matches its transactions endpoint: positive =
 * cash leaving the account (a buy or fee). Flip it so negative = cash out, same
 * as Transaction.amount.
 */
function normalizeInvestmentTransaction(
  raw: PlaidInvestmentTransaction,
  sec: PlaidSecurity | undefined,
): InvestmentTransaction {
  return {
    id: raw.investment_transaction_id,
    accountId: raw.account_id,
    date: raw.date,
    name: raw.name,
    type: raw.type,
    subtype: raw.subtype || undefined,
    quantity: raw.quantity,
    price: raw.price,
    amount: -raw.amount,
    fees: raw.fees ?? undefined,
    currency: raw.iso_currency_code || "USD",
    securityId: raw.security_id || undefined,
    securityName: sec?.name || undefined,
    ticker: sec?.ticker_symbol || undefined,
  };
}

/**
 * Bond terms. Plaid's structured fixed_income field is rarely populated for
 * munis, so fall back to the description, which brokers write in several
 * formats, e.g.
 *   "CPN: 5.000% Due : 1/1/2045 Callable at $100.000 on 1/1/2035"
 *   "... Cpn 5.000% Due 03/15/45 Dtd 12/17/24 ... Call 03/15/35 @ 100.000"
 *   "... 5% Due 07/01/2045 Callable 07/01/2034 @ 100"
 *   "... Ser a Jun23 05.000%Oct01 2048 ..."
 * Returns undefined when nothing is found.
 */
export function fixedIncomeTerms(sec: PlaidSecurity): FixedIncomeTerms | undefined {
  const terms: FixedIncomeTerms = {};
  const fi = sec.fixed_income;
  if (fi?.yield_rate?.type === "coupon") terms.couponRate = fi.yield_rate.percentage;
  if (fi?.maturity_date) terms.maturityDate = fi.maturity_date;

  const name = sec.name || "";
  if (terms.couponRate === undefined) {
    const cpn = name.match(/\bcpn:?\s*(\d+(?:\.\d+)?)\s*%/i) || name.match(/(\d+(?:\.\d+)?)\s*%/);
    if (cpn) terms.couponRate = parseFloat(cpn[1]);
  }
  if (!terms.maturityDate) {
    const due = name.match(/\bdue\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (due) terms.maturityDate = usDate(due[1]);
  }
  if (!terms.maturityDate) {
    // "05.000%Oct01 2048"
    const md = name.match(/%\s*([A-Z][a-z]{2})(\d{2})\s+(\d{4})/);
    const month = md && MONTHS.indexOf(md[1]) + 1;
    if (md && month) terms.maturityDate = `${md[3]}-${String(month).padStart(2, "0")}-${md[2]}`;
  }
  const call =
    name.match(/callable at \$([\d.]+) on (\d{1,2}\/\d{1,2}\/\d{2,4})/i) ||
    name.match(/\bcall(?:able)?\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*@\s*([\d.]+)/i);
  if (call) {
    const priceFirst = call[0].toLowerCase().includes(" at $");
    terms.callDate = usDate(priceFirst ? call[2] : call[1]);
    terms.callPrice = parseFloat(priceFirst ? call[1] : call[2]);
  }

  return Object.keys(terms).length ? terms : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "M/D/YYYY" or "MM/DD/YY" -> "YYYY-MM-DD" (two-digit years are 20xx). */
function usDate(s: string): string {
  const [m, d, y] = s.split("/");
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function defaultDateFrom(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
