import { defineEntity, p } from '@mikro-orm/core';
import { WagerTransactionEntity } from './wager-transaction.entity.js';
import { WalletEntity } from './wallet.entity.js';

/**
 * MikroORM persistence model for an immutable wallet ledger entry.
 *
 * Each entry records the balance before and after one financial movement.
 * Database checks enforce the arithmetic relationship and prevent negative
 * balances from being persisted.
 */
export const WalletLedgerEntryEntity = defineEntity({
  name: 'WalletLedgerEntry',
  tableName: 'wallet_ledger_entries',
  properties: {
    /** Stable ledger entry identifier. */
    id: p.text().primary(),
    /** Wallet whose balance was changed. */
    wallet: p.manyToOne(WalletEntity).fieldName('wallet_id'),
    /** Wager transaction that produced this ledger entry. */
    transaction: p
      .manyToOne(WagerTransactionEntity)
      .fieldName('transaction_id'),
    /** Whether the movement debited or credited the wallet. */
    direction: p.text().check(`"direction" in ('DEBIT', 'CREDIT')`),
    /** Positive amount moved by the entry. */
    amount: p.decimal('string').precision(20).scale(2).check('"amount" > 0'),
    /** Currency used by the entry and its wallet. */
    currency: p.string().length(3).check(`"currency" ~ '^[A-Z]{3}$'`),
    /** Wallet balance immediately before the movement. */
    balanceBefore: p
      .decimal('string')
      .fieldName('balance_before')
      .precision(20)
      .scale(2)
      .check('"balance_before" >= 0'),
    /** Wallet balance immediately after the movement. */
    balanceAfter: p
      .decimal('string')
      .fieldName('balance_after')
      .precision(20)
      .scale(2)
      .check(
        `"balance_after" >= 0 and (("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount") or ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount"))`,
      ),
    /** Time at which the ledger entry was recorded. */
    createdAt: p.datetime().fieldName('created_at').defaultRaw('now()'),
  },
  uniques: [
    {
      /** Prevents one transaction from creating duplicate entries for a wallet. */
      name: 'wallet_ledger_entries_transaction_wallet_unique',
      properties: ['transaction', 'wallet'],
    },
  ],
  indexes: [
    {
      /** Supports chronological wallet ledger reads. */
      name: 'wallet_ledger_entries_wallet_created_idx',
      properties: ['wallet', 'createdAt'],
    },
  ],
});
