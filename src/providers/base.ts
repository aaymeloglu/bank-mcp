import type {
  BankAccount,
  Transaction,
  Balance,
  TransactionFilter,
  ConfigField,
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

  /** Describe config fields for the init wizard. */
  abstract getConfigSchema(): ConfigField[];
}
