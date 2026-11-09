import { CurrencyMismatchError, Money } from '../money/money.js';
import {
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';

// Use the same currency helper so each test focuses on transaction behavior.
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

// This represents the smallest valid provider payload used by most scenarios.
const transactionProps = (
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) => ({
  id: 'transaction-1',
  providerId: 'provider-1',
  externalTransactionId: 'external-1',
  idempotencyKey: 'provider-1:external-1',
  payloadHash: 'hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00'),
  ...overrides,
});

describe('WagerTransaction', () => {
  describe('creation and queries', () => {
    // Creation is intentionally side-effect free: processing happens later.
    it('creates a pending transaction', () => {
      // New operations remain pending until the application use case applies them.
      const transaction = WagerTransaction.create(transactionProps());

      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.isTerminal()).toBe(false);
      expect(transaction.affectsBalance()).toBe(true);
      expect(transaction.requiresReference()).toBe(false);
    });

    // Refunds and rollbacks must be linked to an earlier provider operation.
    it('requires references for refunds and rollbacks', () => {
      // Reversal operations cannot be applied without identifying their source.
      expect(() =>
        WagerTransaction.create(
          transactionProps({ kind: WagerTransactionKind.Refund }),
        ),
      ).toThrow(InvalidWagerTransactionError);
      expect(() =>
        WagerTransaction.create(
          transactionProps({ kind: WagerTransactionKind.Rollback }),
        ),
      ).toThrow(InvalidWagerTransactionError);
    });

    // LOSS is auditable, but it does not create a debit or credit.
    it('identifies loss as a non-financial transaction', () => {
      // LOSS records a result but must not create a ledger movement.
      const transaction = WagerTransaction.create(
        transactionProps({ kind: WagerTransactionKind.Loss }),
      );

      expect(transaction.affectsBalance()).toBe(false);
      expect(() => transaction.ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
    });

    // The hash distinguishes a safe replay from the same key with changed data.
    it('matches payload hashes for idempotent replays', () => {
      const transaction = WagerTransaction.create(transactionProps());

      expect(transaction.matchesPayload('hash-1')).toBe(true);
      expect(transaction.matchesPayload('different-hash')).toBe(false);
    });
  });

  describe('state transitions', () => {
    // A normal transaction reaches a terminal processed state with a timestamp.
    it('processes a bet and records its processing time', () => {
      const transaction = WagerTransaction.create(transactionProps());
      const processedAt = new Date('2026-01-02T00:00:00.000Z');

      transaction.markProcessed(undefined, processedAt);

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.processedAt).toEqual(processedAt);
      expect(transaction.isTerminal()).toBe(true);
    });

    // A reversal is processed only after its internal reference is resolved.
    it('processes a reference-dependent transaction', () => {
      const transaction = WagerTransaction.create(
        transactionProps({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'bet-external-1',
        }),
      );

      transaction.markProcessed('bet-internal-1', new Date());

      expect(transaction.referenceTransactionId).toBe('bet-internal-1');
      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    });

    // Missing references are retried instead of being applied speculatively.
    it('moves a reference-dependent transaction to pending reference', () => {
      const transaction = WagerTransaction.create(
        transactionProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'bet-external-1',
        }),
      );

      transaction.markPendingReference();

      expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    });

    // Rejection and infrastructure failure are distinct terminal outcomes.
    it('rejects and fails pending transactions with stable failure codes', () => {
      const rejected = WagerTransaction.create(transactionProps());
      const failed = WagerTransaction.create(
        transactionProps({ id: 'transaction-2' }),
      );

      rejected.reject(FailureCode.InsufficientBalance);
      failed.fail(FailureCode.InfrastructureFailure);

      expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
      expect(rejected.failureCode).toBe(FailureCode.InsufficientBalance);
      expect(failed.status).toBe(WagerTransactionStatus.Failed);
      expect(failed.failureCode).toBe(FailureCode.InfrastructureFailure);
    });

    it('does not allow transitions from terminal states', () => {
      // Terminal records are immutable in status and cannot be processed twice.
      const transaction = WagerTransaction.create(transactionProps());
      transaction.reject(FailureCode.InvalidPayload);

      expect(() => transaction.markProcessed(undefined, new Date())).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => transaction.fail(FailureCode.InfrastructureFailure)).toThrow(
        InvalidTransactionStateError,
      );
    });
  });

  describe('ledger direction', () => {
    // Each financial kind maps to the direction recorded in the wallet ledger.
    it.each([
      [WagerTransactionKind.Opening, LedgerDirection.Credit],
      [WagerTransactionKind.Win, LedgerDirection.Credit],
      [WagerTransactionKind.Refund, LedgerDirection.Credit],
      [WagerTransactionKind.Bet, LedgerDirection.Debit],
    ])('maps %s to %s', (kind, direction) => {
      const transaction = WagerTransaction.create(
        transactionProps({
          kind,
          ...(kind === WagerTransactionKind.Refund
            ? { referenceExternalTransactionId: 'bet-1' }
            : {}),
        }),
      );

      expect(transaction.ledgerDirectionFor()).toBe(direction);
    });

    // ROLLBACK applies the opposite direction of the referenced operation.
    it('inverts the direction for a rollback', () => {
      const rollback = WagerTransaction.create(
        transactionProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'bet-1',
        }),
      );
      const bet = WagerTransaction.create(transactionProps());

      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    });

    // Direction cannot be calculated until the referenced transaction is known.
    it('rejects a rollback without a resolved reference', () => {
      const rollback = WagerTransaction.create(
        transactionProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'bet-1',
        }),
      );

      expect(() => rollback.ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
    });

    // A reversal across currencies would corrupt the wallet's financial history.
    it('rejects rollback references with another currency', () => {
      const rollback = WagerTransaction.create(
        transactionProps({
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'bet-1',
        }),
      );
      const usdBet = WagerTransaction.create(
        transactionProps({
          money: Money.from({ amount: '25.00', currency: 'USD' }),
        }),
      );

      expect(() => rollback.ledgerDirectionFor(usdBet)).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe('rehydration', () => {
    // Rehydration restores terminal data exactly as persisted for replay and audit.
    it('rehydrates terminal state and preserves its fields', () => {
      const processedAt = new Date('2026-01-02T00:00:00.000Z');
      const transaction = WagerTransaction.rehydrate({
        ...transactionProps(),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        status: WagerTransactionStatus.Processed,
        processedAt,
      });

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.processedAt).toEqual(processedAt);
    });
  });
});
