import { CurrencyMismatchError, InvalidMoneyError, Money } from './money.js';

describe('Money', () => {
  describe('arithmetic', () => {
    // Monetary values must be added without converting them to floating point.
    it('adds decimal values without floating-point precision loss', () => {
      const result = Money.from({ amount: '25.00', currency: 'BRL' }).add(
        Money.from({ amount: '0.10', currency: 'BRL' }),
      );

      expect(result.toJSON()).toEqual({ amount: '25.10', currency: 'BRL' });
    });

    // Input and output must preserve exactly two decimal places.
    it('normalizes valid decimal strings to a fixed two-decimal scale', () => {
      expect(
        Money.from({ amount: '00025.10', currency: 'BRL' }).toString(),
      ).toBe('25.10');
      expect(Money.from({ amount: '0.00', currency: 'BRL' }).toString()).toBe(
        '0.00',
      );
    });

    // Money allows negative results; Wallet applies the non-negative balance rule.
    it('subtracts and negates values', () => {
      const money = Money.from({ amount: '25.00', currency: 'BRL' });

      expect(
        money
          .subtract(Money.from({ amount: '5.25', currency: 'BRL' }))
          .toString(),
      ).toBe('19.75');
      expect(
        money
          .subtract(Money.from({ amount: '30.00', currency: 'BRL' }))
          .toString(),
      ).toBe('-5.00');
      expect(money.negate().toString()).toBe('-25.00');
      expect(money.toString()).toBe('25.00');
    });
  });

  describe('validation', () => {
    // Input contracts accept only non-negative decimal strings with fixed scale.
    it.each([
      '25',
      '25.0',
      '25.000',
      '25,00',
      '1e2',
      'NaN',
      'Infinity',
      '',
      '-1.00',
    ])('rejects invalid amount "%s"', (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    // The currency must be an uppercase ISO-4217 code.
    it.each(['', 'brl', 'BR', 'BRLL', '123', 'ABC'])(
      'rejects invalid currency "%s"',
      (currency) => {
        expect(() => Money.from({ amount: '1.00', currency })).toThrow(
          InvalidMoneyError,
        );
      },
    );

    // Mixing currencies would produce an invalid financial result.
    it('rejects operations between different currencies', () => {
      const brl = Money.from({ amount: '1.00', currency: 'BRL' });
      const usd = Money.from({ amount: '1.00', currency: 'USD' });

      // Currency mismatches must fail before any arithmetic or comparison.
      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe('comparisons', () => {
    // Zero must not be classified as positive or negative.
    it('creates zero and reports the sign of each value', () => {
      const zero = Money.zero('BRL');
      const positive = Money.from({ amount: '1.00', currency: 'BRL' });
      const negative = positive.negate();

      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);
      expect(positive.isPositive()).toBe(true);
      expect(positive.isZero()).toBe(false);
      expect(negative.isNegative()).toBe(true);
      expect(negative.isZero()).toBe(false);
    });

    // Equality depends on value, and ordering must be consistent in both directions.
    it('compares equal and ordered values', () => {
      const one = Money.from({ amount: '1.00', currency: 'BRL' });
      const sameOne = Money.from({ amount: '1.00', currency: 'BRL' });
      const two = Money.from({ amount: '2.00', currency: 'BRL' });

      expect(one.equals(sameOne)).toBe(true);
      expect(one.equals(two)).toBe(false);
      expect(one.isLessThan(two)).toBe(true);
      expect(two.isLessThan(one)).toBe(false);
    });
  });

  describe('serialization and immutability', () => {
    // Events and API responses need a stable JSON representation.
    it('serializes to JSON and a fixed-scale decimal string', () => {
      const money = Money.from({ amount: '1.50', currency: 'BRL' });

      expect(money.toString()).toBe('1.50');
      expect(money.toJSON()).toEqual({ amount: '1.50', currency: 'BRL' });
      expect(JSON.stringify(money)).toBe('{"amount":"1.50","currency":"BRL"}');
    });

    // Value objects do not change after creation; each operation returns another instance.
    it('returns new instances for every arithmetic operation', () => {
      const original = Money.from({ amount: '10.00', currency: 'BRL' });
      const other = Money.from({ amount: '2.00', currency: 'BRL' });

      expect(original.add(other)).not.toBe(original);
      expect(original.subtract(other)).not.toBe(original);
      expect(original.negate()).not.toBe(original);
      expect(original.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
      expect(Object.isFrozen(original)).toBe(true);
    });
  });
});
