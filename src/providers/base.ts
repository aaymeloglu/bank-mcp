import type {
  BankAccount,
  Transaction,
  Balance,
  TransactionFilter,
  ConfigField,
  Holding,
  InvestmentTransaction,
  InvestmentTransactionFilter,
  Liability,
  ConnectionStatus,
} from "../types.js";

/**
 * Abstract base for all bank providers.
 *
 * Each provider translates a specific banking API into the normalized
 * BankAccount / Transaction / Balance types.
 */
export abstract class BankProvider {
  abstract readonly name: string;
  abstract readonly displayName: string;

  /** Throw if required config fields are missing or invalid. */
  abstract validateConfig(config: Record<string, unknown>): void;

  /** Fetch all accounts accessible via this connection. */
  abstract listAccounts(
    config: Record<string, unknown>,
  ): Promise<BankAccount[]>;

  /** Fetch transactions with optional filtering. */
  abstract listTransactions(
    config: Record<string, unknown>,
    accountId: string,
    filter?: TransactionFilter,
  ): Promise<Transaction[]>;

  /** Fetch current balance(s) for an account. */
  abstract getBalance(
    config: Record<string, unknown>,
    accountId: string,
  ): Promise<Balance[]>;

  /**
   * Optional: fetch balances for many accounts in one request. Providers whose
   * API returns every account of a connection at once (Plaid) implement this so
   * callers make one request per connection instead of one per account, which
   * both speeds things up and stays under per-item rate limits.
   * `accountIds` omitted = all accounts on the connection.
   */
  getBalances?(
    config: Record<string, unknown>,
    accountIds?: string[],
  ): Promise<Balance[]>;

  /**
   * Optional: current investment positions (brokerage accounts). Providers
   * without an investments API leave this undefined.
   * `accountIds` omitted = all accounts on the connection.
   */
  getHoldings?(
    config: Record<string, unknown>,
    accountIds?: string[],
  ): Promise<Holding[]>;

  /** Optional: buys, sells, income and fees in brokerage accounts. */
  listInvestmentTransactions?(
    config: Record<string, unknown>,
    accountIds: string[] | undefined,
    filter?: InvestmentTransactionFilter,
  ): Promise<InvestmentTransaction[]>;

  /** Optional: card and loan payment terms (due dates, APRs, payoff). */
  getLiabilities?(
    config: Record<string, unknown>,
    accountIds?: string[],
  ): Promise<Liability[]>;

  /**
   * Optional: whether the connection is healthy (e.g. needs a re-login) and
   * when data last refreshed. connectionId/provider are filled in by the caller.
   */
  getConnectionStatus?(
    config: Record<string, unknown>,
  ): Promise<Omit<ConnectionStatus, "connectionId" | "provider">>;

  /** Describe config fields for the init wizard. */
  abstract getConfigSchema(): ConfigField[];
}
