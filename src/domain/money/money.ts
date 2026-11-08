export interface MoneyProps {
  /** Decimal amount with exactly two fractional digits. */
  amount: string;
  /** Uppercase ISO-4217 currency code, for example `BRL`. */
  currency: string;
}

export class InvalidMoneyError extends Error {
  /** Creates an error for an invalid monetary amount or currency. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends Error {
  /** Creates an error raised when arithmetic mixes different currencies. */
  constructor(left: string, right: string) {
    super(`Currency mismatch: ${left} and ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  private static readonly isoCurrencyCodes = new Set(
    Intl.supportedValuesOf('currency'),
  );

  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Creates money from a non-negative decimal string.
   *
   * The input must use exactly two fractional digits. The value is stored as
   * integer cents to avoid floating-point precision errors.
   *
   * @throws {InvalidMoneyError} If the amount or currency is invalid.
   */
  static from({ amount, currency }: MoneyProps): Money {
    const normalizedCurrency = Money.validateCurrency(currency);
    const cents = Money.parseAmount(amount);

    return new Money(cents, normalizedCurrency);
  }

  /**
   * Creates a zero-valued amount for a valid ISO-4217 currency.
   *
   * @throws {InvalidMoneyError} If the currency is invalid.
   */
  static zero(currency: string): Money {
    return new Money(0n, Money.validateCurrency(currency));
  }

  /**
   * Adds another amount without mutating either operand.
   *
   * @throws {CurrencyMismatchError} If the currencies differ.
   */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  /**
   * Subtracts another amount without mutating either operand.
   *
   * @throws {CurrencyMismatchError} If the currencies differ.
   */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  /** Returns the additive inverse without mutating this amount. */
  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  /** Returns whether the amount is exactly zero. */
  isZero(): boolean {
    return this.cents === 0n;
  }

  /** Returns whether the amount is greater than zero. */
  isPositive(): boolean {
    return this.cents > 0n;
  }

  /** Returns whether the amount is less than zero. */
  isNegative(): boolean {
    return this.cents < 0n;
  }

  /**
   * Compares this amount with another amount.
   *
   * @throws {CurrencyMismatchError} If the currencies differ.
   */
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  /**
   * Compares amount and currency equality.
   *
   * @throws {CurrencyMismatchError} If the currencies differ.
   */
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  /** Returns the stable API and event representation of this amount. */
  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  /** Returns the amount as a signed decimal string with exactly two decimals. */
  toString(): string {
    const sign = this.cents < 0n ? '-' : '';
    const absoluteCents = this.cents < 0n ? -this.cents : this.cents;
    const units = absoluteCents / 100n;
    const fractional = (absoluteCents % 100n).toString().padStart(2, '0');

    return `${sign}${units}.${fractional}`;
  }

  /** Parses a validated two-decimal amount into integer cents. */
  private static parseAmount(amount: string): bigint {
    if (typeof amount !== 'string' || /^\d+\.\d{2}$/.test(amount) === false) {
      throw new InvalidMoneyError(
        'Money amount must be a non-negative decimal with exactly 2 decimal places',
      );
    }

    const [units, fractional] = amount.split('.');
    return BigInt(units) * 100n + BigInt(fractional);
  }

  /** Validates and returns an uppercase ISO-4217 currency code. */
  private static validateCurrency(currency: string): string {
    if (
      typeof currency !== 'string' ||
      /^[A-Z]{3}$/.test(currency) === false ||
      Money.isoCurrencyCodes.has(currency) === false
    ) {
      throw new InvalidMoneyError(
        'Money currency must be a 3-letter ISO-4217 code',
      );
    }

    return currency;
  }

  /** Ensures arithmetic and comparisons are performed in one currency. */
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
