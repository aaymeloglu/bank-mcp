/**
 * Normalized banking types — all providers map to these.
 */

export interface BankAccount {
  uid: string;
  iban: string;
  name: string;
  currency: string;
  connectionId: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  date: string; // "YYYY-MM-DD"
  amount: number; // Signed: negative = expense
  currency: string;
  description: string;
  merchantName?: string;
  category?: string;
  type: "debit" | "credit";
  reference?: string;
  rawData?: Record<string, unknown>;
}

export interface Balance {
  accountId: string;
  amount: number;
  currency: string;
  type: string; // "closingBooked" | "expected" | etc.
}

/** Bond terms. Parsed from the security name when the API has no structured field. */
export interface FixedIncomeTerms {
  couponRate?: number; // percent, e.g. 5 for 5.000%
  maturityDate?: string; // "YYYY-MM-DD"
  callDate?: string; // "YYYY-MM-DD", next call
  callPrice?: number; // per 100 face
}

export interface Holding {
  accountId: string;
  securityId: string;
  name: string;
  type?: string; // "equity" | "fixed income" | "mutual fund" | "cash" | ...
  ticker?: string;
  cusip?: string;
  isCashEquivalent: boolean;
  quantity: number; // shares, or face value for bonds
  price?: number; // bonds: per 100 face
  priceAsOf?: string;
  value: number;
  costBasis?: number;
  currency: string;
  fixedIncome?: FixedIncomeTerms;
}

export interface InvestmentTransaction {
  id: string;
  accountId: string;
  date: string; // "YYYY-MM-DD"
  name: string;
  type: string; // "buy" | "sell" | "cash" | "fee" | "transfer" | ...
  subtype?: string;
  quantity: number;
  price: number;
  amount: number; // Signed: negative = cash leaving the account
  fees?: number;
  currency: string;
  securityId?: string;
  securityName?: string;
  ticker?: string;
}

export interface InvestmentTransactionFilter {
  dateFrom?: string;
  dateTo?: string;
}

export interface Apr {
  type?: string; // "purchase_apr" | "cash_apr" | "balance_transfer_apr" | ...
  percentage: number;
}

/** Payment terms for a credit card or loan. Account numbers are never included. */
export interface Liability {
  accountId: string;
  kind: "credit" | "loan" | "mortgage" | "student";
  nextPaymentDueDate?: string; // "YYYY-MM-DD"
  nextPaymentAmount?: number; // minimum payment for cards
  lastPaymentDate?: string;
  lastPaymentAmount?: number;
  isOverdue?: boolean;
  // Cards
  lastStatementDate?: string;
  lastStatementBalance?: number;
  aprs?: Apr[];
  // Loans
  interestRate?: number; // percent
  principalBalance?: number;
  payoffAmount?: number;
  originationPrincipal?: number;
  maturityDate?: string;
  ytdInterestPaid?: number;
}

export interface ConnectionStatus {
  connectionId: string;
  provider: string;
  institution?: string;
  ok: boolean;
  errorCode?: string; // e.g. "ITEM_LOGIN_REQUIRED"
  errorMessage?: string;
  lastSuccessfulUpdate?: Record<string, string>; // product -> ISO timestamp
  lastFailedUpdate?: Record<string, string>;
  consentExpiresAt?: string;
}

export interface TransactionFilter {
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  type?: "debit" | "credit";
  limit?: number;
}

export interface ConfigField {
  name: string;
  label: string;
  type: "string" | "path" | "select";
  required: boolean;
  secret?: boolean;
  options?: string[];
  default?: string;
}

export interface ConnectionConfig {
  id: string;
  provider: string;
  label: string;
  config: Record<string, unknown>;
}

export interface AppConfig {
  version: number;
  connections: ConnectionConfig[];
  defaults: {
    transactionDays: number;
    currency: string;
  };
}

export const EXPENSE_CATEGORIES = [
  "housing",
  "transportation",
  "food",
  "utilities",
  "insurance",
  "healthcare",
  "entertainment",
  "other",
] as const;

export const INCOME_CATEGORIES = [
  "salary",
  "freelance",
  "investments",
  "rental",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
