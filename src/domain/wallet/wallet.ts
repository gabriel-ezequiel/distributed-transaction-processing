import { CurrencyMismatchError, Money } from '../money/money.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InvalidWalletError extends Error {
  /** Creates an error for invalid wallet state or movement. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletError';
  }
}

export class InsufficientBalanceError extends Error {
  /** Creates an error when a debit would make the wallet balance negative. */
  constructor() {
    super('Wallet balance is insufficient');
    this.name = 'InsufficientBalanceError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet with its initial balance and version one.
   *
   * @throws {InvalidWalletError} If identity, initial balance, or dates are invalid.
   * @throws {CurrencyMismatchError} If the initial balance currency differs from
   * the wallet currency.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    Wallet.assertIdentifier(props.id, 'id');
    Wallet.assertIdentifier(props.playerId, 'playerId');

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('Wallet initial balance cannot be negative');
    }

    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /**
   * Rebuilds a wallet from already-persisted state without applying transitions.
   *
   * @throws {InvalidWalletError} If persisted state is structurally invalid.
   * @throws {CurrencyMismatchError} If balance and wallet currencies differ.
   */
  static rehydrate(state: WalletState): Wallet {
    Wallet.assertIdentifier(state.id, 'id');
    Wallet.assertIdentifier(state.playerId, 'playerId');

    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new InvalidWalletError('Wallet version must be a positive integer');
    }

    if (
      Number.isNaN(state.createdAt.getTime()) ||
      Number.isNaN(state.updatedAt.getTime())
    ) {
      throw new InvalidWalletError('Wallet dates must be valid');
    }

    if (state.balance.currency !== state.currency) {
      throw new CurrencyMismatchError(state.currency, state.balance.currency);
    }

    if (state.balance.isNegative()) {
      throw new InvalidWalletError('Wallet balance cannot be negative');
    }

    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  /** Returns the current materialized balance. */
  get balance(): Money {
    return this._balance;
  }

  /** Returns the optimistic-lock version of this wallet. */
  get version(): number {
    return this._version;
  }

  /** Returns the timestamp of the most recent balance change. */
  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  /**
   * Debits a positive amount and increments the wallet version.
   *
   * @throws {InvalidWalletError} If the amount is not positive.
   * @throws {CurrencyMismatchError} If the amount currency differs.
   * @throws {InsufficientBalanceError} If the debit exceeds the balance.
   */
  debit(amount: Money, at = new Date()): void {
    this.assertMovement(amount, at);

    if (this._balance.isLessThan(amount)) {
      throw new InsufficientBalanceError();
    }

    this.applyBalance(this._balance.subtract(amount), at);
  }

  /**
   * Credits a positive amount and increments the wallet version.
   *
   * @throws {InvalidWalletError} If the amount is not positive.
   * @throws {CurrencyMismatchError} If the amount currency differs.
   */
  credit(amount: Money, at = new Date()): void {
    this.assertMovement(amount, at);
    this.applyBalance(this._balance.add(amount), at);
  }

  private applyBalance(balance: Money, at: Date): void {
    this._balance = balance;
    this._version += 1;
    this._updatedAt = new Date(at);
  }

  private assertMovement(amount: Money, at: Date): void {
    this.assertSameCurrency(amount);

    if (!amount.isPositive()) {
      throw new InvalidWalletError('Wallet movement must be positive');
    }

    if (Number.isNaN(at.getTime())) {
      throw new InvalidWalletError('Wallet movement date must be valid');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private static assertIdentifier(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidWalletError(`Wallet ${field} must not be empty`);
    }
  }
}
