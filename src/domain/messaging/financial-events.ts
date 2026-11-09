import {
  IntegrationEvent,
  IntegrationEventProps,
} from './integration-event.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../ledger/wallet-ledger-entry.js';
import { MoneyProps } from '../money/money.js';
import { Wallet } from '../wallet/wallet.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
} from '../wager-transaction/wager-transaction.js';

/**
 * Identifiers shared by events emitted during one financial operation.
 */
export interface EventContext {
  /** Unique identifier for the event occurrence. */
  eventId: string;
  /** Identifier used to correlate the complete operation. */
  correlationId: string;
  /** Optional command or message that caused this event. */
  causationId?: string;
  /** Event time; defaults to the transaction or current time when omitted. */
  occurredAt?: Date;
}

/** Data published when a wager transaction reaches PROCESSED. */
export interface WagerTransactionProcessedData {
  /** Internal transaction identifier. */
  transactionId: string;
  /** Provider-owned transaction identifier. */
  externalTransactionId: string;
  /** Financial operation type. */
  kind: WagerTransactionKind;
  /** Final processing status. */
  status: 'PROCESSED';
  /** Transaction amount in a JSON-safe representation. */
  money: MoneyProps;
  /** Internal reference resolved by processing, when applicable. */
  referenceTransactionId?: string;
}

/** Event emitted for every successfully applied transaction, including LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  /** Builds an event from a processed transaction. */
  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionProcessed {
    if (transaction.status !== 'PROCESSED') {
      throw new InvalidFinancialEventError(
        'WagerTransactionProcessed requires a processed transaction',
      );
    }

    return new WagerTransactionProcessed({
      eventId: context.eventId,
      aggregateId: transaction.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt ?? transaction.processedAt ?? new Date(),
      data: {
        transactionId: transaction.id,
        externalTransactionId: transaction.externalTransactionId,
        kind: transaction.kind,
        status: 'PROCESSED',
        money: transaction.money.toJSON(),
        ...(transaction.referenceTransactionId
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
      },
    });
  }

  private constructor(
    props: IntegrationEventProps<WagerTransactionProcessedData>,
  ) {
    super(props);
  }
}

/** Data published when a wager transaction is rejected by a business rule. */
export interface WagerTransactionRejectedData {
  /** Internal transaction identifier. */
  transactionId: string;
  /** Provider-owned transaction identifier. */
  externalTransactionId: string;
  /** Operation that was rejected. */
  kind: WagerTransactionKind;
  /** Stable reason consumed by callers. */
  failureCode: FailureCode;
  /** Rejected transaction amount. */
  money: MoneyProps;
}

/** Event emitted for terminal business-rule rejections. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  /** Builds an event from a rejected transaction. */
  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionRejected {
    if (transaction.status !== 'REJECTED' || !transaction.failureCode) {
      throw new InvalidFinancialEventError(
        'WagerTransactionRejected requires a rejected transaction with a failure code',
      );
    }

    return new WagerTransactionRejected({
      eventId: context.eventId,
      aggregateId: transaction.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt ?? new Date(),
      data: {
        transactionId: transaction.id,
        externalTransactionId: transaction.externalTransactionId,
        kind: transaction.kind,
        failureCode: transaction.failureCode,
        money: transaction.money.toJSON(),
      },
    });
  }

  private constructor(
    props: IntegrationEventProps<WagerTransactionRejectedData>,
  ) {
    super(props);
  }
}

/** Data published when a wallet balance changes. */
export interface WalletBalanceChangedData {
  /** Wallet whose balance changed. */
  walletId: string;
  /** Transaction that caused the movement. */
  transactionId: string;
  /** Direction of the balance movement. */
  direction: LedgerDirection;
  /** Amount moved. */
  money: MoneyProps;
  /** Balance before the movement. */
  balanceBefore: MoneyProps;
  /** Balance after the movement. */
  balanceAfter: MoneyProps;
  /** New optimistic-lock version of the wallet. */
  walletVersion: number;
}

/** Event emitted only when a ledger movement changes the wallet balance. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  /** Builds an event from a wallet and its balanced ledger entry. */
  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidFinancialEventError(
        'Ledger entry wallet does not match the wallet event aggregate',
      );
    }
    if (!entry.isBalanced()) {
      throw new InvalidFinancialEventError(
        'WalletBalanceChanged requires a balanced ledger entry',
      );
    }

    return new WalletBalanceChanged({
      eventId: context.eventId,
      aggregateId: wallet.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt ?? entry.createdAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }
}

/** Data published while a transaction waits for an out-of-order reference. */
export interface WagerTransactionPendingReferenceData {
  /** Internal transaction identifier. */
  transactionId: string;
  /** Provider-owned reference that has not arrived yet. */
  referenceExternalTransactionId: string;
  /** Operation waiting for the reference. */
  kind: WagerTransactionKind;
  /** Transaction amount. */
  money: MoneyProps;
}

/** Event emitted when a REFUND or ROLLBACK cannot yet resolve its reference. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  /** Builds an event from a transaction in PENDING_REFERENCE. */
  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    if (
      transaction.status !== 'PENDING_REFERENCE' ||
      !transaction.referenceExternalTransactionId
    ) {
      throw new InvalidFinancialEventError(
        'Pending-reference event requires a transaction waiting for a reference',
      );
    }

    return new WagerTransactionPendingReference({
      eventId: context.eventId,
      aggregateId: transaction.id,
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt ?? new Date(),
      data: {
        transactionId: transaction.id,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
      },
    });
  }

  private constructor(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    super(props);
  }
}

/** Raised when a financial event does not match its aggregate state. */
export class InvalidFinancialEventError extends Error {
  /** Creates an error for an invalid financial event projection. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFinancialEventError';
  }
}
