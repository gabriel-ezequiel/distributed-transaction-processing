import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';
import { CurrencyMismatchError, Money } from '../money/money.js';

export enum WagerTransactionKind {
  /** Internal opening credit created when a wallet is opened. */
  Opening = 'OPENING',
  /** Debit requested by the game provider. */
  Bet = 'BET',
  /** Credit resulting from a winning bet. */
  Win = 'WIN',
  /** Non-financial result that does not change the wallet balance. */
  Loss = 'LOSS',
  /** Full credit reversal of a processed bet. */
  Refund = 'REFUND',
  /** Reversal of a previously processed financial transaction. */
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted but not applied yet. */
  Pending = 'PENDING',
  /** Waiting for a referenced transaction to arrive. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied successfully; terminal state. */
  Processed = 'PROCESSED',
  /** Rejected by a business rule; terminal state. */
  Rejected = 'REJECTED',
  /** Permanently failed due to infrastructure; terminal state. */
  Failed = 'FAILED',
}

export enum FailureCode {
  /** The provider payload violates the input contract. */
  InvalidPayload = 'INVALID_PAYLOAD',
  /** A debit cannot be covered by the current wallet balance. */
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  /** The referenced transaction is incompatible with the operation. */
  InvalidReference = 'INVALID_REFERENCE',
  /** The referenced transaction does not exist yet or cannot be found. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A reversal would produce a negative wallet balance. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** A permanent infrastructure failure prevented processing. */
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}

export interface CreateWagerTransactionProps {
  /** Internal transaction identifier. */
  id: string;
  /** Provider that originated the operation. */
  providerId: string;
  /** Provider-owned transaction identifier. */
  externalTransactionId: string;
  /** Persistent key used to detect idempotent replays. */
  idempotencyKey: string;
  /** Hash of the canonical business payload. */
  payloadHash: string;
  /** Wallet affected by the operation. */
  walletId: string;
  /** Player who owns the wallet. */
  playerId: string;
  /** Game round associated with the operation. */
  roundId: string;
  /** Game associated with the operation. */
  gameId: string;
  /** Financial operation type. */
  kind: WagerTransactionKind;
  /** Positive amount and currency requested by the provider. */
  money: Money;
  /** Provider-owned identifier of the transaction being reversed. */
  referenceExternalTransactionId?: string;
  /** Creation timestamp; defaults to the current time. */
  createdAt?: Date;
}

export interface WagerTransactionState {
  /** Internal transaction identifier. */
  id: string;
  /** Provider that originated the operation. */
  providerId: string;
  /** Provider-owned transaction identifier. */
  externalTransactionId: string;
  /** Persistent idempotency key. */
  idempotencyKey: string;
  /** Canonical payload hash used for replay comparison. */
  payloadHash: string;
  /** Wallet affected by the operation. */
  walletId: string;
  /** Player who owns the wallet. */
  playerId: string;
  /** Game round associated with the operation. */
  roundId: string;
  /** Game associated with the operation. */
  gameId: string;
  /** Financial operation type. */
  kind: WagerTransactionKind;
  /** Positive amount and currency stored for the operation. */
  money: Money;
  /** Provider-owned reference identifier, when required. */
  referenceExternalTransactionId?: string;
  /** Original creation timestamp. */
  createdAt: Date;
  /** Persisted lifecycle state. */
  status: WagerTransactionStatus;
  /** Internal ID of the resolved referenced transaction. */
  referenceTransactionId?: string;
  /** Stable code explaining rejection or permanent failure. */
  failureCode?: FailureCode;
  /** Timestamp at which the operation was applied. */
  processedAt?: Date;
  /** Number of attempts made to resolve the external reference. */
  referenceAttempts?: number;
  /** Earliest timestamp at which the next reference retry may run. */
  nextReferenceAttemptAt?: Date;
}

export class InvalidTransactionStateError extends Error {
  /** Creates an error for an invalid transaction transition. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

export class InvalidWagerTransactionError extends Error {
  /** Creates an error for invalid transaction data. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class WagerTransaction {
  /**
   * Keeps identifying data immutable while allowing only controlled lifecycle
   * transitions through the methods below.
   */
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /**
   * Creates a transaction in PENDING state.
   *
   * @throws {InvalidWagerTransactionError} If data or reference requirements
   * are invalid.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertStructure(props);

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt ?? new Date()),
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Rebuilds persisted state without reapplying a domain transition.
   *
   * @throws {InvalidWagerTransactionError} If persisted data is structurally invalid.
   */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    WagerTransaction.assertStructure(state);
    WagerTransaction.assertStatusData(state);

    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt) : undefined,
      state.referenceAttempts ?? 0,
      state.nextReferenceAttemptAt
        ? new Date(state.nextReferenceAttemptAt)
        : undefined,
    );
  }

  /** Returns the current transaction status. */
  get status(): WagerTransactionStatus {
    return this._status;
  }

  /** Returns the internal ID of the referenced transaction, when resolved. */
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  /** Returns the stable machine-readable failure code, when present. */
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Returns the processing timestamp, when the transaction was processed. */
  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt
      ? new Date(this._nextReferenceAttemptAt)
      : undefined;
  }

  /**
   * Marks the transaction as processed.
   *
   * @throws {InvalidTransactionStateError} If the current state is terminal or
   * the required reference is missing.
   */
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();

    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionStateError(
        'A referenced transaction is required before processing',
      );
    }

    if (!WagerTransaction.isValidDate(at)) {
      throw new InvalidWagerTransactionError('Processed date must be valid');
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at);
    this._failureCode = undefined;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Marks a reference-dependent transaction as waiting for its reference. */
  markPendingReference(nextAttemptAt = new Date()): void {
    this.assertMutable();

    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(
        'Only reference-dependent transactions can be pending',
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = new Date(nextAttemptAt);
  }

  /** Rejects the transaction for a terminal business-rule failure. */
  reject(code: FailureCode): void {
    this.assertMutable();
    this.assertFailureCode(code);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  /** Marks the transaction as permanently failed and auditably terminal. */
  fail(code: FailureCode): void {
    this.assertMutable();
    this.assertFailureCode(code);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  /** Returns whether the transaction is in a terminal state. */
  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** Returns whether this transaction changes the wallet balance. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** Returns whether this transaction needs a provider reference. */
  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  /** Returns whether the payload hash matches an idempotent replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Determines the ledger direction for this transaction.
   *
   * @throws {InvalidWagerTransactionError} If the kind does not affect balance
   * or a rollback reference is missing.
   * @throws {CurrencyMismatchError} If a rollback reference uses another currency.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError(
            'Rollback requires a referenced transaction',
          );
        }
        if (reference.money.currency !== this.money.currency) {
          throw new CurrencyMismatchError(
            this.money.currency,
            reference.money.currency,
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          'LOSS does not produce a ledger entry',
        );
    }
  }

  private assertMutable(): void {
    // Terminal transactions are append-only audit records after this point.
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Transaction is already terminal: ${this._status}`,
      );
    }
  }

  private assertFailureCode(code: FailureCode): void {
    // Failure codes are persisted and consumed by providers, so they must be stable.
    if (!Object.values(FailureCode).includes(code)) {
      throw new InvalidWagerTransactionError('Failure code is invalid');
    }
  }

  private static assertStructure(
    props: CreateWagerTransactionProps | WagerTransactionState,
  ): void {
    // Validate shared identity and business fields before constructing the entity.
    for (const [field, value] of Object.entries(props)) {
      if (
        [
          'createdAt',
          'processedAt',
          'money',
          'kind',
          'status',
          'direction',
          'referenceAttempts',
          'nextReferenceAttemptAt',
        ].includes(field)
      ) {
        continue;
      }
      if (
        value !== undefined &&
        (typeof value !== 'string' || value.trim() === '')
      ) {
        throw new InvalidWagerTransactionError(
          `Transaction ${field} must not be empty`,
        );
      }
    }

    if (!props.money || !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'Transaction money must be positive',
      );
    }

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError('Transaction kind is invalid');
    }

    if (
      props.referenceExternalTransactionId === undefined &&
      [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(
        props.kind,
      )
    ) {
      throw new InvalidWagerTransactionError(
        'This transaction kind requires a reference',
      );
    }

    // Dates are validated here so persistence and event timestamps are reliable.
    if (!WagerTransaction.isValidDate(props.createdAt ?? new Date())) {
      throw new InvalidWagerTransactionError('Transaction date must be valid');
    }
  }

  private static assertStatusData(state: WagerTransactionState): void {
    // Rehydrated terminal states must contain the data needed for audit and replay.
    if (!Object.values(WagerTransactionStatus).includes(state.status)) {
      throw new InvalidWagerTransactionError('Transaction status is invalid');
    }

    if (
      state.status === WagerTransactionStatus.Processed &&
      !state.processedAt
    ) {
      throw new InvalidWagerTransactionError(
        'Processed transactions require processedAt',
      );
    }

    if (
      [WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(
        state.status,
      ) &&
      !state.failureCode
    ) {
      throw new InvalidWagerTransactionError(
        'Rejected and failed transactions require a failure code',
      );
    }
  }

  private static isValidDate(value: Date): boolean {
    // Invalid Date objects otherwise pass TypeScript's structural type checks.
    return value instanceof Date && !Number.isNaN(value.getTime());
  }
}
