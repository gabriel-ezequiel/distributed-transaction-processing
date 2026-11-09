import { CurrencyMismatchError, Money } from '../money/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class InvalidLedgerEntryError extends Error {
  /** Creates an error for an invalid ledger entry. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {}

  /**
   * Creates an immutable, balanced ledger entry.
   *
   * @throws {InvalidLedgerEntryError} If the entry is invalid or unbalanced.
   * @throws {CurrencyMismatchError} If monetary values use different currencies.
   */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertStructure(props);
    WalletLedgerEntry.assertNonNegative(props.balanceBefore, 'balanceBefore');
    WalletLedgerEntry.assertNonNegative(props.balanceAfter, 'balanceAfter');

    const createdAt = props.createdAt ?? new Date();
    WalletLedgerEntry.assertValidDate(createdAt);

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(createdAt),
    );

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        'Ledger entry does not balance before and after the movement',
      );
    }

    return entry;
  }

  /**
   * Rebuilds an entry from persisted state without applying a new transition.
   *
   * Arithmetic consistency remains observable through `isBalanced`.
   *
   * @throws {InvalidLedgerEntryError} If persisted structure is invalid.
   * @throws {CurrencyMismatchError} If monetary values use different currencies.
   */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    WalletLedgerEntry.assertStructure(state);
    WalletLedgerEntry.assertValidDate(state.createdAt);

    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  /** Returns whether the entry arithmetic matches its direction. */
  isBalanced(): boolean {
    const expectedBalance =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }

  /** Returns a defensive copy so the entry timestamp cannot be mutated externally. */
  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  private static assertStructure(
    props: CreateLedgerEntryProps | LedgerEntryState,
  ): void {
    WalletLedgerEntry.assertIdentifier(props.id, 'id');
    WalletLedgerEntry.assertIdentifier(props.walletId, 'walletId');
    WalletLedgerEntry.assertIdentifier(props.transactionId, 'transactionId');

    if (
      props.direction !== LedgerDirection.Debit &&
      props.direction !== LedgerDirection.Credit
    ) {
      throw new InvalidLedgerEntryError('Ledger direction is invalid');
    }

    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger money must be positive');
    }

    WalletLedgerEntry.assertSameCurrency(props.money, props.balanceBefore);
    WalletLedgerEntry.assertSameCurrency(props.money, props.balanceAfter);
  }

  private static assertNonNegative(money: Money, field: string): void {
    if (money.isNegative()) {
      throw new InvalidLedgerEntryError(`${field} cannot be negative`);
    }
  }

  private static assertSameCurrency(left: Money, right: Money): void {
    if (left.currency !== right.currency) {
      throw new CurrencyMismatchError(left.currency, right.currency);
    }
  }

  private static assertIdentifier(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidLedgerEntryError(`Ledger ${field} must not be empty`);
    }
  }

  private static assertValidDate(value: Date): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidLedgerEntryError(
        'Ledger createdAt must be a valid date',
      );
    }
  }
}
