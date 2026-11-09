import { describe, expect, it } from 'vitest';
import {
  InvalidFinancialEventError,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './financial-events.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../ledger/wallet-ledger-entry.js';
import { Money } from '../money/money.js';
import { Wallet } from '../wallet/wallet.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
} from '../wager-transaction/wager-transaction.js';

const money = Money.from({ amount: '10.00', currency: 'BRL' });
const eventContext = {
  eventId: 'event-1',
  correlationId: 'correlation-1',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
};

function createTransaction(kind = WagerTransactionKind.Bet) {
  return WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money,
    referenceExternalTransactionId:
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback
        ? 'reference-1'
        : undefined,
  });
}

describe('financial integration events', () => {
  describe('transaction lifecycle events', () => {
    it('serializes a processed transaction with its event type and version', () => {
      // Processed events include LOSS because they represent an applied decision,
      // even when that decision does not change the wallet balance.
      const transaction = createTransaction(WagerTransactionKind.Loss);
      transaction.markProcessed(undefined, eventContext.occurredAt);

      const event = WagerTransactionProcessed.from(transaction, eventContext);

      expect(event.toJSON()).toMatchObject({
        eventType: 'WagerTransactionProcessed',
        version: 1,
        aggregateId: 'transaction-1',
        data: {
          transactionId: 'transaction-1',
          kind: 'LOSS',
          status: 'PROCESSED',
          money: { amount: '10.00', currency: 'BRL' },
        },
      });
    });

    it('serializes the stable failure code for a rejected transaction', () => {
      // Consumers use the persisted code rather than parsing human-readable errors.
      const transaction = createTransaction();
      transaction.reject(FailureCode.InsufficientBalance);

      const event = WagerTransactionRejected.from(transaction, eventContext);

      expect(event.eventType).toBe('WagerTransactionRejected');
      expect(event.version).toBe(1);
      expect(event.data.failureCode).toBe(FailureCode.InsufficientBalance);
    });

    it('serializes a transaction waiting for an out-of-order reference', () => {
      // The reference identifier is retained so a worker can find the waiting record.
      const transaction = createTransaction(WagerTransactionKind.Refund);
      transaction.markPendingReference();

      const event = WagerTransactionPendingReference.from(
        transaction,
        eventContext,
      );

      expect(event.data.referenceExternalTransactionId).toBe('reference-1');
      expect(event.toJSON().eventType).toBe('WagerTransactionPendingReference');
    });
  });

  describe('wallet balance event', () => {
    it('serializes a balanced ledger movement without exposing Money instances', () => {
      // Integration payloads contain MoneyProps so they remain JSON-safe and versionable.
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.from({ amount: '20.00', currency: 'BRL' }),
      });
      const balanceBefore = wallet.balance;
      wallet.debit(money, eventContext.occurredAt);
      const entry = WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: wallet.id,
        transactionId: 'transaction-1',
        direction: LedgerDirection.Debit,
        money,
        balanceBefore,
        balanceAfter: wallet.balance,
        createdAt: eventContext.occurredAt,
      });

      const event = WalletBalanceChanged.from(wallet, entry, eventContext);

      expect(event.data).toEqual({
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: 'DEBIT',
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '20.00', currency: 'BRL' },
        balanceAfter: { amount: '10.00', currency: 'BRL' },
        walletVersion: 2,
      });
      expect(event.data.money).not.toBe(money);
    });

    it('rejects a ledger entry belonging to another wallet', () => {
      // An event must never attribute a balance movement to the wrong aggregate.
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.from({ amount: '20.00', currency: 'BRL' }),
      });
      const entry = WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-2',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Credit,
        money,
        balanceBefore: Money.zero('BRL'),
        balanceAfter: money,
      });

      expect(() =>
        WalletBalanceChanged.from(wallet, entry, eventContext),
      ).toThrow(InvalidFinancialEventError);
    });
  });
});
