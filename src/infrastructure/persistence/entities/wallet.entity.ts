import { defineEntity, p } from '@mikro-orm/core';

/**
 * MikroORM persistence model for a player's wallet.
 *
 * The entity stores the current balance together with an optimistic-lock
 * version. Domain behavior remains in the Wallet aggregate; this definition
 * describes the database shape and its invariants.
 */
export const WalletEntity = defineEntity({
  name: 'Wallet',
  tableName: 'wallets',
  properties: {
    /** Stable wallet identifier used as the primary key. */
    id: p.text().primary(),
    /** Player that owns this wallet. */
    playerId: p.text().fieldName('player_id'),
    /** ISO-4217 currency code stored in uppercase form. */
    currency: p.string().length(3).check(`"currency" ~ '^[A-Z]{3}$'`),
    /** Current monetary balance, persisted as an exact decimal string. */
    balanceAmount: p
      .decimal('string')
      .fieldName('balance_amount')
      .precision(20)
      .scale(2)
      .default('0')
      .check('"balance_amount" >= 0'),
    /** Optimistic-concurrency version incremented after each balance change. */
    version: p.integer().default(1).check('"version" >= 1'),
    /** Time at which the wallet row was created. */
    createdAt: p.datetime().fieldName('created_at').defaultRaw('now()'),
    /** Time at which the wallet row was most recently changed. */
    updatedAt: p.datetime().fieldName('updated_at').defaultRaw('now()'),
  },
  uniques: [
    {
      /** Prevents more than one wallet for a player and currency pair. */
      name: 'wallets_player_currency_unique',
      properties: ['playerId', 'currency'],
    },
  ],
});
