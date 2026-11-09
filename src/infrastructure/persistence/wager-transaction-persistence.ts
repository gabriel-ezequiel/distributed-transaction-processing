import { randomUUID } from 'node:crypto';
import { EntityManager, InferEntity, LockMode } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import { Money } from '../../domain/money/money.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionState,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.js';
import { Wallet, WalletState } from '../../domain/wallet/wallet.js';
import {
  ProcessWagerTransactionResult,
  WagerTransactionRecord,
  WagerTransactionStore,
  WagerTransactionUnitOfWork,
} from '../../application/wagering/process-wager-transaction.js';
import { InboxMessageEntity } from './entities/inbox-message.entity.js';
import { OutboxMessageEntity } from './entities/outbox-message.entity.js';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from './entities/wager-transaction.entity.js';
import { WalletEntity } from './entities/wallet.entity.js';

type WalletRow = InferEntity<typeof WalletEntity>;
type WagerTransactionRow = InferEntity<typeof WagerTransactionEntity>;
type InboxRow = InferEntity<typeof InboxMessageEntity>;

/** Converts a persisted wallet row into its domain aggregate. */
export function mapWalletToDomain(row: WalletRow): Wallet {
  const state: WalletState = {
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({
      amount: row.balanceAmount,
      currency: row.currency,
    }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return Wallet.rehydrate(state);
}

/** Converts a persisted wager transaction row into its domain entity. */
export function mapWagerTransactionToDomain(
  row: WagerTransactionRow,
): WagerTransaction {
  const state: WagerTransactionState = {
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.wallet.id,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId:
      row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: row.failureCode ? (row.failureCode as FailureCode) : undefined,
    processedAt: row.processedAt ?? undefined,
  };
  return WagerTransaction.rehydrate(state);
}

function mapResult(
  row: WagerTransactionRow,
): ProcessWagerTransactionResult | undefined {
  if (row.resultBalanceAmount === null && row.resultWalletVersion === null) {
    return undefined;
  }
  return {
    transactionId: row.id,
    status: row.status as WagerTransactionStatus,
    ...(row.failureCode ? { failureCode: row.failureCode as FailureCode } : {}),
    ...(typeof row.resultBalanceAmount === 'string' &&
    typeof row.resultBalanceCurrency === 'string' &&
    typeof row.resultWalletVersion === 'number'
      ? {
          balance: {
            amount: row.resultBalanceAmount,
            currency: row.resultBalanceCurrency,
          },
          walletVersion: row.resultWalletVersion,
        }
      : {}),
    idempotentReplay: false,
  };
}

function applyResult(
  row: WagerTransactionRow,
  result: ProcessWagerTransactionResult | undefined,
): void {
  row.resultBalanceAmount = result?.balance?.amount ?? null;
  row.resultBalanceCurrency = result?.balance?.currency ?? null;
  row.resultWalletVersion = result?.walletVersion ?? null;
}

/** MikroORM unit of work used by the financial application service. */
@Injectable()
export class MikroOrmWagerTransactionUnitOfWork implements WagerTransactionUnitOfWork {
  constructor(private readonly entityManager: EntityManager) {}

  /** Runs all financial writes in one SQL transaction with a fresh identity map. */
  transactional<T>(
    work: (store: WagerTransactionStore) => Promise<T>,
  ): Promise<T> {
    return this.entityManager.transactional(
      (em) => work(new MikroOrmWagerTransactionStore(em)),
      { clear: true },
    );
  }
}

/**
 * Transaction-scoped MikroORM adapter.
 *
 * Wallet reads use `FOR UPDATE`; callers must use this store only through the
 * unit of work so the lock and all writes share one database transaction.
 */
export class MikroOrmWagerTransactionStore implements WagerTransactionStore {
  private readonly walletRows = new Map<string, WalletRow>();
  private readonly inboxRows = new Map<string, InboxRow>();

  constructor(private readonly entityManager: EntityManager) {}

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransactionRecord | undefined> {
    const row = await this.entityManager.findOne(WagerTransactionEntity, {
      providerId,
      idempotencyKey,
    });
    return row
      ? {
          transaction: mapWagerTransactionToDomain(row),
          result: mapResult(row),
        }
      : undefined;
  }

  async findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.entityManager.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    return row ? mapWagerTransactionToDomain(row) : undefined;
  }

  async findReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.entityManager.findOne(WagerTransactionEntity, {
      providerId,
      referenceExternalTransactionId,
      kind,
    });
    return row ? mapWagerTransactionToDomain(row) : undefined;
  }

  async findWalletForUpdate(walletId: string): Promise<Wallet | undefined> {
    const row = await this.entityManager.findOne(
      WalletEntity,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!row) {
      return undefined;
    }
    this.walletRows.set(walletId, row);
    return mapWalletToDomain(row);
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const row = this.walletRows.get(wallet.id);
    if (!row) {
      throw new Error(`Wallet was not locked before saving: ${wallet.id}`);
    }
    row.balanceAmount = wallet.balance.toString();
    row.version = wallet.version;
    row.updatedAt = wallet.updatedAt;
  }

  async saveTransaction(record: WagerTransactionRecord): Promise<void> {
    const transaction = record.transaction;
    const row =
      (await this.entityManager.findOne(WagerTransactionEntity, {
        id: transaction.id,
      })) ??
      this.entityManager.create(WagerTransactionEntity, {
        id: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: transaction.idempotencyKey,
        payloadHash: transaction.payloadHash,
        wallet: this.entityManager.getReference(
          WalletEntity,
          transaction.walletId,
        ),
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        amount: transaction.money.toString(),
        currency: transaction.money.currency,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId ?? null,
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        status: transaction.status,
        failureCode: transaction.failureCode ?? null,
        createdAt: transaction.createdAt,
        processedAt: transaction.processedAt ?? null,
      });

    row.referenceTransactionId = transaction.referenceTransactionId ?? null;
    row.status = transaction.status;
    row.failureCode = transaction.failureCode ?? null;
    row.processedAt = transaction.processedAt ?? null;
    applyResult(row, record.result);
    this.entityManager.persist(row);
  }

  async saveLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    const row = this.entityManager.create(WalletLedgerEntryEntity, {
      id: entry.id,
      wallet: this.entityManager.getReference(WalletEntity, entry.walletId),
      transaction: this.entityManager.getReference(
        WagerTransactionEntity,
        entry.transactionId,
      ),
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      createdAt: entry.createdAt,
    });
    this.entityManager.persist(row);
  }

  async saveOutboxMessage(message: OutboxMessage): Promise<void> {
    const row = this.entityManager.create(OutboxMessageEntity, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
    });
    this.entityManager.persist(row);
  }

  async findInbox(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    const row = await this.entityManager.findOne(InboxMessageEntity, {
      consumerName,
      messageId,
    });
    if (row) {
      this.inboxRows.set(`${consumerName}:${messageId}`, row);
    }
    return row ? mapInboxToDomain(row) : undefined;
  }

  async saveInbox(message: InboxMessage): Promise<void> {
    const key = `${message.consumerName}:${message.messageId}`;
    const row =
      this.inboxRows.get(key) ??
      this.entityManager.create(InboxMessageEntity, {
        id: randomUUID(),
        messageId: message.messageId,
        consumerName: message.consumerName,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt ?? null,
      });
    row.processedAt = message.processedAt ?? null;
    this.inboxRows.set(key, row);
    this.entityManager.persist(row);
  }
}

function mapInboxToDomain(row: InboxRow): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: row.messageId,
    consumerName: row.consumerName,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });
}
