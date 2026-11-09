import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from '../money/money.js';
import {
  InsufficientBalanceError,
  InvalidWalletError,
  Wallet,
} from './wallet.js';

// Keeping test amounts in one helper makes the wallet scenarios easier to read.
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Wallet', () => {
  describe('opening and rehydration', () => {
    // Opening establishes the aggregate identity, initial balance, and version baseline.
    it('opens with the initial balance and version one', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('100.00'),
      });

      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(wallet.createdAt);
    });

    // Empty identifiers cannot safely identify a wallet or its player.
    it.each([
      ['id', { id: '', playerId: 'player-1' }],
      ['playerId', { id: 'wallet-1', playerId: ' ' }],
    ])('rejects an empty %s', (_, identity) => {
      expect(() =>
        Wallet.open({ ...identity, initialBalance: brl('0.00') }),
      ).toThrow(InvalidWalletError);
    });

    // Rehydration must preserve persisted state instead of applying a new transition.
    it('rehydrates persisted state without changing its version', () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const updatedAt = new Date('2026-01-02T00:00:00.000Z');

      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: brl('75.00'),
        version: 4,
        createdAt,
        updatedAt,
      });

      expect(wallet.version).toBe(4);
      expect(wallet.balance.toString()).toBe('75.00');
      expect(wallet.createdAt).toEqual(createdAt);
      expect(wallet.updatedAt).toEqual(updatedAt);
    });
  });

  describe('movements', () => {
    // A successful debit changes both the materialized balance and its version.
    it('debits the balance and increments the version', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('100.00'),
      });
      const at = new Date('2026-01-02T00:00:00.000Z');

      wallet.debit(brl('25.00'), at);

      expect(wallet.balance.toString()).toBe('75.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(at);
    });

    // Credits follow the same versioning rule as debits.
    it('credits the balance and increments the version', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('100.00'),
      });

      wallet.credit(brl('25.00'));

      expect(wallet.balance.toString()).toBe('125.00');
      expect(wallet.version).toBe(2);
    });

    // The aggregate must reject the entire movement before changing any state.
    it('rejects a debit that would make the balance negative', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('10.00'),
      });

      expect(() => wallet.debit(brl('10.01'))).toThrow(
        InsufficientBalanceError,
      );
      expect(wallet.balance.toString()).toBe('10.00');
      expect(wallet.version).toBe(1);
    });

    // Zero-value movements do not represent a valid financial operation.
    it('rejects a zero movement', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('10.00'),
      });

      expect(() => wallet.credit(brl('0.00'))).toThrow(InvalidWalletError);
      expect(wallet.version).toBe(1);
    });

    // Money validates input contracts before a value can reach the wallet.
    it('rejects a negative movement before it reaches the Wallet', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('10.00'),
      });

      expect(() => brl('-1.00')).toThrow(InvalidMoneyError);
      expect(wallet.version).toBe(1);
    });

    // Every movement must use the wallet's currency to preserve monetary meaning.
    it('rejects movements in another currency', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('10.00'),
      });
      const usd = Money.from({ amount: '1.00', currency: 'USD' });

      expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
      expect(wallet.balance.toString()).toBe('10.00');
    });
  });

  describe('immutability boundaries', () => {
    // Returning defensive date copies prevents callers from mutating aggregate state.
    it('does not expose mutable date references', () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: brl('10.00'),
        version: 1,
        createdAt,
        updatedAt: createdAt,
      });

      wallet.updatedAt.setFullYear(2030);

      expect(wallet.updatedAt).toEqual(createdAt);
    });
  });
});
