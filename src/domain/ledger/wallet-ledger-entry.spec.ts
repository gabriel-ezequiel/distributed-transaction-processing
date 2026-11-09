import { CurrencyMismatchError, Money } from '../money/money.js';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const baseEntry = (
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'transaction-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  describe('creation', () => {
    it('creates a balanced debit entry', () => {
      // A debit must reduce the balance by exactly the ledger amount.
      const entry = WalletLedgerEntry.create(baseEntry());

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.isBalanced()).toBe(true);
      expect(entry.balanceAfter.toString()).toBe('75.00');
    });

    it('creates a balanced credit entry', () => {
      // A credit must increase the balance without changing its currency.
      const entry = WalletLedgerEntry.create(
        baseEntry({
          direction: LedgerDirection.Credit,
          balanceBefore: brl('75.00'),
          balanceAfter: brl('100.00'),
        }),
      );

      expect(entry.isBalanced()).toBe(true);
      expect(entry.balanceAfter.toString()).toBe('100.00');
    });

    it('rejects an unbalanced entry', () => {
      // The ledger is the audit source, so arithmetic inconsistencies are invalid.
      expect(() =>
        WalletLedgerEntry.create(baseEntry({ balanceAfter: brl('74.99') })),
      ).toThrow(InvalidLedgerEntryError);
    });

    it.each(['id', 'walletId', 'transactionId'])(
      'rejects an empty %s',
      (field) => {
        // Every entry must be traceable to a wallet and financial transaction.
        expect(() =>
          WalletLedgerEntry.create(baseEntry({ [field]: ' ' })),
        ).toThrow(InvalidLedgerEntryError);
      },
    );

    it('rejects a non-positive movement', () => {
      // A zero or negative ledger amount cannot represent a movement direction.
      expect(() =>
        WalletLedgerEntry.create(baseEntry({ money: brl('0.00') })),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejects negative balances', () => {
      // The ledger must never record a balance below zero.
      expect(() =>
        WalletLedgerEntry.create(
          baseEntry({
            balanceBefore: brl('10.00'),
            balanceAfter: brl('15.00').negate(),
          }),
        ),
      ).toThrow();
    });

    it('rejects different currencies', () => {
      // A ledger line cannot combine monetary values from different currencies.
      expect(() =>
        WalletLedgerEntry.create(
          baseEntry({
            money: Money.from({ amount: '25.00', currency: 'USD' }),
          }),
        ),
      ).toThrow(CurrencyMismatchError);
    });
  });

  describe('rehydration and immutability', () => {
    it('rehydrates persisted entries without changing their values', () => {
      // Rehydration reconstructs stored state; it does not apply another movement.
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const entry = WalletLedgerEntry.rehydrate({
        ...baseEntry(),
        createdAt,
      });

      expect(entry.id).toBe('entry-1');
      expect(entry.createdAt).toEqual(createdAt);
      expect(entry.isBalanced()).toBe(true);
    });

    it('does not expose a mutable timestamp reference', () => {
      // Persisted timestamps must remain stable after callers receive the entry.
      const entry = WalletLedgerEntry.create(baseEntry());
      const original = entry.createdAt;

      original.setFullYear(2030);

      expect(entry.createdAt).not.toEqual(original);
      expect(entry.createdAt.getFullYear()).not.toBe(2030);
    });
  });
});
