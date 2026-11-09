import { describe, expect, it } from 'vitest';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction.js';
import { Money } from '../../domain/money/money.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  IdempotencyConflictError,
  ProcessWagerTransaction,
  ProcessWagerTransactionCommand,
  WagerTransactionRecord,
  WagerTransactionStore,
  WagerTransactionUnitOfWork,
} from './process-wager-transaction.js';

class InMemoryWagerStore implements WagerTransactionStore {
  readonly transactions: WagerTransactionRecord[] = [];
  readonly ledger: WalletLedgerEntry[] = [];
  readonly outbox: OutboxMessage[] = [];
  readonly inbox: InboxMessage[] = [];

  constructor(private readonly wallet: Wallet) {}

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransactionRecord | undefined> {
    return this.transactions.find(
      ({ transaction }) =>
        transaction.providerId === providerId &&
        transaction.idempotencyKey === idempotencyKey,
    );
  }

  async findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.transactions.find(
      ({ transaction }) =>
        transaction.providerId === providerId &&
        transaction.externalTransactionId === externalTransactionId,
    )?.transaction;
  }

  async findReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | undefined> {
    return this.transactions.find(
      ({ transaction }) =>
        transaction.providerId === providerId &&
        transaction.kind === kind &&
        transaction.referenceExternalTransactionId ===
          referenceExternalTransactionId,
    )?.transaction;
  }

  async findWalletForUpdate(walletId: string): Promise<Wallet | undefined> {
    return this.wallet.id === walletId ? this.wallet : undefined;
  }

  async saveTransaction(record: WagerTransactionRecord): Promise<void> {
    this.transactions.push(record);
  }

  async saveLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    this.ledger.push(entry);
  }

  async saveOutboxMessage(message: OutboxMessage): Promise<void> {
    this.outbox.push(message);
  }

  async findInbox(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    return this.inbox.find(
      (message) =>
        message.consumerName === consumerName &&
        message.messageId === messageId,
    );
  }

  async saveInbox(message: InboxMessage): Promise<void> {
    this.inbox.push(message);
  }
}

class InMemoryUnitOfWork implements WagerTransactionUnitOfWork {
  constructor(readonly store: InMemoryWagerStore) {}

  async transactional<T>(
    work: (store: WagerTransactionStore) => Promise<T>,
  ): Promise<T> {
    return work(this.store);
  }
}

const occurredAt = new Date('2026-01-01T00:00:00.000Z');

function command(
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  return {
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
    correlationId: 'correlation-1',
    occurredAt,
    ...overrides,
  };
}

function createUseCase(initialBalance = '100.00') {
  const wallet = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
  });
  const unitOfWork = new InMemoryUnitOfWork(new InMemoryWagerStore(wallet));
  const useCase = new ProcessWagerTransaction(
    unitOfWork,
    (() => {
      let counter = 0;
      return () => `generated-${++counter}`;
    })(),
  );
  return { useCase, store: unitOfWork.store, wallet };
}

describe('ProcessWagerTransaction', () => {
  describe('financial processing', () => {
    it('debits the wallet, creates one ledger entry, and emits two events', async () => {
      // The wallet, ledger, transaction, and outbox writes share one unit of work.
      const { useCase, store, wallet } = createUseCase();

      const result = await useCase.execute(command());

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance).toEqual({ amount: '90.00', currency: 'BRL' });
      expect(wallet.balance.toString()).toBe('90.00');
      expect(store.ledger).toHaveLength(1);
      expect(store.outbox.map(({ eventType }) => eventType)).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    });

    it('processes LOSS without changing the wallet or creating a ledger entry', async () => {
      // LOSS is an auditable decision but has no monetary movement.
      const { useCase, store, wallet } = createUseCase();

      const result = await useCase.execute(
        command({
          kind: WagerTransactionKind.Loss,
          externalTransactionId: 'loss-1',
          idempotencyKey: 'loss-key',
        }),
      );

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.toString()).toBe('100.00');
      expect(store.ledger).toHaveLength(0);
      expect(store.outbox.map(({ eventType }) => eventType)).toEqual([
        'WagerTransactionProcessed',
      ]);
    });

    it('rejects an insufficient debit with a stable failure code', async () => {
      // A business rejection is persisted and published without changing balance.
      const { useCase, store, wallet } = createUseCase('5.00');

      const result = await useCase.execute(command());

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.InsufficientBalance);
      expect(wallet.balance.toString()).toBe('5.00');
      expect(store.ledger).toHaveLength(0);
      expect(store.outbox[0]?.eventType).toBe('WagerTransactionRejected');
    });
  });

  describe('idempotency and references', () => {
    it('returns the original result for an identical replay', async () => {
      // A replay must not debit the wallet or append another ledger entry.
      const { useCase, store, wallet } = createUseCase();

      const first = await useCase.execute(command());
      const replay = await useCase.execute(command());

      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(wallet.balance.toString()).toBe('90.00');
      expect(store.ledger).toHaveLength(1);
    });

    it('rejects a replay with a different payload hash', async () => {
      // Reusing a key for another payload is a conflict, not a second operation.
      const { useCase } = createUseCase();
      await useCase.execute(command());

      await expect(
        useCase.execute(command({ payloadHash: 'different-hash' })),
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it('persists a missing reference as PENDING_REFERENCE', async () => {
      // Out-of-order reversals wait for a later worker retry instead of applying partially.
      const { useCase, store } = createUseCase();

      const result = await useCase.execute(
        command({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'bet-not-yet-received',
        }),
      );

      expect(result.status).toBe(WagerTransactionStatus.PendingReference);
      expect(store.ledger).toHaveLength(0);
      expect(store.outbox[0]?.eventType).toBe(
        'WagerTransactionPendingReference',
      );
    });

    it('marks a transport message processed in the same unit of work', async () => {
      // A redelivery can be acknowledged only because the Inbox record committed with the work.
      const { useCase, store } = createUseCase();

      await useCase.execute(
        command({ messageId: 'message-1', consumerName: 'wager-consumer' }),
      );

      expect(store.inbox).toHaveLength(1);
      expect(store.inbox[0]?.isProcessed()).toBe(true);
    });
  });
});
