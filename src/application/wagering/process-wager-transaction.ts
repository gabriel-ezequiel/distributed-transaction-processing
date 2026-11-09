import { randomUUID } from 'node:crypto';
import {
  EventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/financial-events.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { IntegrationEvent } from '../../domain/messaging/integration-event.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/ledger/wallet-ledger-entry.js';
import { Money, MoneyProps } from '../../domain/money/money.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';

/**
 * Command accepted by both HTTP and message consumers.
 */
export interface ProcessWagerTransactionCommand {
  /** Provider that originated the operation. */
  providerId: string;
  /** Provider-owned transaction identifier. */
  externalTransactionId: string;
  /** Durable idempotency key. */
  idempotencyKey: string;
  /** Hash of the canonical request payload. */
  payloadHash: string;
  /** Wallet affected by the operation. */
  walletId: string;
  /** Player that owns the wallet. */
  playerId: string;
  /** Game round associated with the operation. */
  roundId: string;
  /** Game associated with the operation. */
  gameId: string;
  /** Financial operation type. */
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  /** Positive amount and currency requested by the provider. */
  money: MoneyProps;
  /** Provider-owned transaction being reversed, when applicable. */
  referenceExternalTransactionId?: string;
  /** Correlation identifier for logs and events. */
  correlationId: string;
  /** Optional transport message identifier for Inbox deduplication. */
  messageId?: string;
  /** Logical SQS consumer name when messageId is present. */
  consumerName?: string;
  /** Event and processing time; defaults to the current time. */
  occurredAt?: Date;
}

/**
 * Stable snapshot returned to an HTTP caller or message adapter.
 *
 * Keeping this snapshot on the transaction record is what makes an idempotent
 * replay return the original observed balance instead of recalculating it.
 */
export interface ProcessWagerTransactionResult {
  /** Internal transaction identifier. */
  transactionId: string;
  /** Current durable transaction status. */
  status: WagerTransactionStatus;
  /** Stable rejection code, when the transaction was rejected. */
  failureCode?: FailureCode;
  /** Balance observed after processing, when a wallet was loaded. */
  balance?: MoneyProps;
  /** Wallet version observed after processing. */
  walletVersion?: number;
  /** Whether this request reused an existing durable result. */
  idempotentReplay: boolean;
}

/**
 * Durable financial records required by the application transaction.
 */
export interface WagerTransactionRecord {
  /** The transaction aggregate. */
  transaction: WagerTransaction;
  /** Original response snapshot for idempotent replay. */
  result?: ProcessWagerTransactionResult;
}

/**
 * Transaction-scoped persistence port.
 *
 * Implementations must lock the wallet in `findWalletForUpdate` and commit all
 * writes made through this port atomically.
 */
export interface WagerTransactionStore {
  /** Lists due pending-reference transactions for retry scheduling. */
  findDuePendingReferenceIds(limit: number, now: Date): Promise<string[]>;
  /** Finds a pending reference transaction and locks its wallet. */
  findPendingReference(
    transactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Finds an existing transaction by its durable idempotency key. */
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransactionRecord | undefined>;
  /** Finds a provider transaction used as a refund or rollback reference. */
  findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Finds an already-created reversal of the same reference and kind. */
  findReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | undefined>;
  /** Acquires the wallet lock for the duration of the SQL transaction. */
  findWalletForUpdate(walletId: string): Promise<Wallet | undefined>;
  /** Persists a new or changed wager transaction. */
  saveTransaction(record: WagerTransactionRecord): Promise<void>;
  /** Persists the changed wallet aggregate after a financial movement. */
  saveWallet(wallet: Wallet): Promise<void>;
  /** Persists an immutable ledger entry. */
  saveLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  /** Persists a serialized integration event in the same transaction. */
  saveOutboxMessage(message: OutboxMessage): Promise<void>;
  /** Persists Inbox state when processing a transport message. */
  findInbox(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined>;
  /** Persists a new Inbox record. */
  saveInbox(message: InboxMessage): Promise<void>;
}

/**
 * Unit-of-work port. The adapter must map this callback to one SQL transaction.
 */
export interface WagerTransactionUnitOfWork {
  transactional<T>(
    work: (store: WagerTransactionStore) => Promise<T>,
  ): Promise<T>;
}

/** Raised when a command conflicts with an existing durable identity. */
export class IdempotencyConflictError extends Error {
  /** Creates an idempotency conflict with a provider-facing message. */
  constructor() {
    super('Idempotency key was already used with a different payload');
    this.name = 'IdempotencyConflictError';
  }
}

/** Raised when the command cannot be processed because required data is absent. */
export class WagerTransactionNotFoundError extends Error {
  /** Creates a not-found error for a wallet or reference transaction. */
  constructor(message: string) {
    super(message);
    this.name = 'WagerTransactionNotFoundError';
  }
}

/**
 * Coordinates the financial aggregate changes and integration events.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: WagerTransactionUnitOfWork,
    private readonly idGenerator: () => string = randomUUID,
  ) {}

  /**
   * Processes a command atomically and returns the original snapshot on replay.
   *
   * @throws {IdempotencyConflictError} If the key has a different payload hash.
   * @throws {WagerTransactionNotFoundError} If the wallet does not exist.
   */
  async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const money = Money.from(command.money);
    const occurredAt = command.occurredAt ?? new Date();
    ProcessWagerTransaction.assertCommand(command, occurredAt);

    return this.unitOfWork.transactional(async (store) => {
      const inboxResult = await this.claimInbox(store, command, occurredAt);
      if (inboxResult) {
        return inboxResult;
      }

      const existing = await store.findByIdempotencyKey(
        command.providerId,
        command.idempotencyKey,
      );
      if (existing) {
        if (!existing.transaction.matchesPayload(command.payloadHash)) {
          throw new IdempotencyConflictError();
        }
        return {
          ...(existing.result ??
            ProcessWagerTransaction.resultFrom(existing.transaction)),
          idempotentReplay: true,
        };
      }

      const existingExternal = await store.findByProviderExternal(
        command.providerId,
        command.externalTransactionId,
      );
      if (existingExternal) {
        if (!existingExternal.matchesPayload(command.payloadHash)) {
          throw new IdempotencyConflictError();
        }
        const externalRecord = await store.findByIdempotencyKey(
          command.providerId,
          existingExternal.idempotencyKey,
        );
        if (externalRecord) {
          return {
            ...(externalRecord.result ??
              ProcessWagerTransaction.resultFrom(existingExternal)),
            idempotentReplay: true,
          };
        }
      }

      const wallet = await store.findWalletForUpdate(command.walletId);
      if (!wallet) {
        throw new WagerTransactionNotFoundError(
          `Wallet not found: ${command.walletId}`,
        );
      }
      if (
        wallet.playerId !== command.playerId ||
        wallet.currency !== money.currency
      ) {
        return this.rejectNewTransaction(
          store,
          command,
          money,
          occurredAt,
          FailureCode.InvalidPayload,
        );
      }

      const transaction = WagerTransaction.create({
        id: this.idGenerator(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: command.payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: occurredAt,
      });

      if (transaction.requiresReference()) {
        return this.processReferenceTransaction(
          store,
          transaction,
          wallet,
          command,
          occurredAt,
        );
      }

      return this.processDirectTransaction(
        store,
        transaction,
        wallet,
        command,
        occurredAt,
      );
    });
  }

  async retryPendingReference(
    transactionId: string,
    maxAttempts: number,
    now = new Date(),
  ): Promise<ProcessWagerTransactionResult | undefined> {
    return this.unitOfWork.transactional(async (store) => {
      const transaction = await store.findPendingReference(transactionId);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
        return undefined;
      }
      if (transaction.nextReferenceAttemptAt && transaction.nextReferenceAttemptAt > now) {
        return undefined;
      }
      const wallet = await store.findWalletForUpdate(transaction.walletId);
      if (!wallet) {
        transaction.fail(FailureCode.InfrastructureFailure);
        const result = ProcessWagerTransaction.resultFrom(transaction);
        await store.saveTransaction({ transaction, result });
        return result;
      }
      const command = ProcessWagerTransaction.commandFrom(transaction);
      if (transaction.referenceAttempts >= maxAttempts) {
        return this.rejectNewTransaction(
          store,
          command,
          transaction.money,
          now,
          FailureCode.ReferenceNotFound,
          transaction,
          wallet,
        );
      }
      return this.processReferenceTransaction(
        store,
        transaction,
        wallet,
        command,
        now,
      );
    });
  }

  private async processDirectTransaction(
    store: WagerTransactionStore,
    transaction: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): Promise<ProcessWagerTransactionResult> {
    if (transaction.kind === WagerTransactionKind.Loss) {
      transaction.markProcessed(undefined, occurredAt);
      return this.persistProcessed(
        store,
        transaction,
        wallet,
        command,
        occurredAt,
      );
    }

    try {
      const before = wallet.balance;
      const direction = transaction.ledgerDirectionFor();
      if (direction === LedgerDirection.Debit) {
        wallet.debit(transaction.money, occurredAt);
      } else {
        wallet.credit(transaction.money, occurredAt);
      }
      const entry = WalletLedgerEntry.create({
        id: this.idGenerator(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction,
        money: transaction.money,
        balanceBefore: before,
        balanceAfter: wallet.balance,
        createdAt: occurredAt,
      });
      transaction.markProcessed(undefined, occurredAt);
      return this.persistProcessed(
        store,
        transaction,
        wallet,
        command,
        occurredAt,
        entry,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'InsufficientBalanceError') {
        return this.rejectNewTransaction(
          store,
          command,
          transaction.money,
          occurredAt,
          FailureCode.InsufficientBalance,
          transaction,
          wallet,
        );
      }
      throw error;
    }
  }

  private async processReferenceTransaction(
    store: WagerTransactionStore,
    transaction: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const referenceId = transaction.referenceExternalTransactionId;
    const reference = referenceId
      ? await store.findByProviderExternal(command.providerId, referenceId)
      : undefined;
    if (!reference) {
      transaction.markPendingReference(
        ProcessWagerTransaction.nextReferenceAttemptAt(
          transaction.referenceAttempts + 1,
          occurredAt,
        ),
      );
      return this.persistWithEvent(
        store,
        transaction,
        ProcessWagerTransaction.resultFrom(transaction),
        WagerTransactionPendingReference.from(
          transaction,
          eventContext(transaction, command, occurredAt),
        ),
      );
    }

    const invalidReference =
      reference.status !== WagerTransactionStatus.Processed ||
      reference.walletId !== wallet.id ||
      reference.playerId !== wallet.playerId ||
      reference.money.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId ||
      (transaction.kind === WagerTransactionKind.Refund &&
        reference.kind !== WagerTransactionKind.Bet) ||
      (transaction.kind === WagerTransactionKind.Rollback &&
        ![
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ].includes(reference.kind)) ||
      !reference.money.equals(transaction.money);
    if (invalidReference) {
      return this.rejectNewTransaction(
        store,
        command,
        transaction.money,
        occurredAt,
        FailureCode.InvalidReference,
        transaction,
        wallet,
      );
    }

    if (
      await store.findReversal(
        command.providerId,
        reference.externalTransactionId,
        transaction.kind,
      )
    ) {
      return this.rejectNewTransaction(
        store,
        command,
        transaction.money,
        occurredAt,
        FailureCode.InvalidReference,
        transaction,
        wallet,
      );
    }

    const before = wallet.balance;
    const direction = transaction.ledgerDirectionFor(reference);
    try {
      if (direction === LedgerDirection.Debit) {
        wallet.debit(transaction.money, occurredAt);
      } else {
        wallet.credit(transaction.money, occurredAt);
      }
    } catch (error) {
      if (transaction.kind === WagerTransactionKind.Rollback) {
        return this.rejectNewTransaction(
          store,
          command,
          transaction.money,
          occurredAt,
          FailureCode.ReversalWouldOverdraw,
          transaction,
          wallet,
        );
      }
      throw error;
    }
    const entry = WalletLedgerEntry.create({
      id: this.idGenerator(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction,
      money: transaction.money,
      balanceBefore: before,
      balanceAfter: wallet.balance,
      createdAt: occurredAt,
    });
    transaction.markProcessed(reference.id, occurredAt);
    return this.persistProcessed(
      store,
      transaction,
      wallet,
      command,
      occurredAt,
      entry,
    );
  }

  private async persistProcessed(
    store: WagerTransactionStore,
    transaction: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
    entry?: WalletLedgerEntry,
  ): Promise<ProcessWagerTransactionResult> {
    const result = ProcessWagerTransaction.resultFrom(transaction, wallet);
    const events: IntegrationEvent<unknown>[] = [
      WagerTransactionProcessed.from(
        transaction,
        eventContext(transaction, command, occurredAt),
      ),
    ];
    if (entry) {
      events.push(
        WalletBalanceChanged.from(
          wallet,
          entry,
          eventContext(transaction, command, occurredAt),
        ),
      );
      await store.saveLedgerEntry(entry);
    }
    await store.saveWallet(wallet);
    await store.saveTransaction({ transaction, result });
    await this.saveEvents(store, events);
    return result;
  }

  private async persistWithEvent(
    store: WagerTransactionStore,
    transaction: WagerTransaction,
    result: ProcessWagerTransactionResult,
    event: IntegrationEvent<unknown>,
  ): Promise<ProcessWagerTransactionResult> {
    await store.saveTransaction({ transaction, result });
    await store.saveOutboxMessage(OutboxMessage.enqueue(event));
    return result;
  }

  private async rejectNewTransaction(
    store: WagerTransactionStore,
    command: ProcessWagerTransactionCommand,
    money: Money,
    occurredAt: Date,
    code: FailureCode,
    transaction = WagerTransaction.create({
      id: this.idGenerator(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: occurredAt,
    }),
    wallet?: Wallet,
  ): Promise<ProcessWagerTransactionResult> {
    transaction.reject(code);
    const result = ProcessWagerTransaction.resultFrom(transaction, wallet);
    await store.saveTransaction({ transaction, result });
    await store.saveOutboxMessage(
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(
          transaction,
          eventContext(transaction, command, occurredAt),
        ),
      ),
    );
    return result;
  }

  private async saveEvents(
    store: WagerTransactionStore,
    events: IntegrationEvent<unknown>[],
  ): Promise<void> {
    for (const event of events) {
      await store.saveOutboxMessage(OutboxMessage.enqueue(event));
    }
  }

  private async claimInbox(
    store: WagerTransactionStore,
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): Promise<ProcessWagerTransactionResult | undefined> {
    if (!command.messageId || !command.consumerName) {
      return undefined;
    }
    const existing = await store.findInbox(
      command.consumerName,
      command.messageId,
    );
    if (existing && existing.payloadHash !== command.payloadHash) {
      throw new IdempotencyConflictError();
    }
    if (existing?.isProcessed()) {
      const transaction = await store.findByIdempotencyKey(
        command.providerId,
        command.idempotencyKey,
      );
      if (transaction?.result) {
        return { ...transaction.result, idempotentReplay: true };
      }
    }
    if (!existing) {
      const received = InboxMessage.receive({
        messageId: command.messageId,
        consumerName: command.consumerName,
        payloadHash: command.payloadHash,
        receivedAt: occurredAt,
      });
      received.markProcessed(occurredAt);
      await store.saveInbox(received);
    } else if (!existing.isProcessed()) {
      // The Inbox status is committed atomically with the financial work.
      existing.markProcessed(occurredAt);
    }
    return undefined;
  }

  private static resultFrom(
    transaction: WagerTransaction,
    wallet?: Wallet,
  ): ProcessWagerTransactionResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      ...(transaction.failureCode
        ? { failureCode: transaction.failureCode }
        : {}),
      ...(wallet
        ? { balance: wallet.balance.toJSON(), walletVersion: wallet.version }
        : {}),
      idempotentReplay: false,
    };
  }

  private static commandFrom(
    transaction: WagerTransaction,
  ): ProcessWagerTransactionCommand {
    return {
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind as Exclude<
        WagerTransactionKind,
        WagerTransactionKind.Opening
      >,
      money: transaction.money.toJSON(),
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      correlationId: `pending-reference:${transaction.id}`,
    };
  }

  private static nextReferenceAttemptAt(attempt: number, now: Date): Date {
    const delaySeconds = Math.min(300, 2 ** Math.max(0, attempt - 1));
    return new Date(now.getTime() + delaySeconds * 1000);
  }

  private static assertCommand(
    command: ProcessWagerTransactionCommand,
    occurredAt: Date,
  ): void {
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new Error('occurredAt must be a valid date');
    }
    if (
      (command.messageId && !command.consumerName) ||
      (!command.messageId && command.consumerName)
    ) {
      throw new Error('messageId and consumerName must be provided together');
    }
  }
}

function eventContext(
  transaction: WagerTransaction,
  command: ProcessWagerTransactionCommand,
  occurredAt: Date,
): EventContext {
  return {
    eventId: randomUUID(),
    correlationId: command.correlationId,
    causationId: command.messageId,
    occurredAt,
  };
}
