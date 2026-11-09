import { defineEntity, p } from '@mikro-orm/core';
import { WalletEntity } from './wallet.entity.js';

/**
 * MikroORM persistence model for an incoming wager transaction.
 *
 * Provider identifiers and idempotency keys are unique so retries cannot
 * create a second financial transaction for the same external request.
 */
export const WagerTransactionEntity = defineEntity({
  name: 'WagerTransaction',
  tableName: 'wager_transactions',
  properties: {
    /** Stable internal transaction identifier. */
    id: p.text().primary(),
    /** External provider that submitted the transaction. */
    providerId: p.text().fieldName('provider_id'),
    /** Provider-owned transaction identifier used for deduplication. */
    externalTransactionId: p.text().fieldName('external_transaction_id'),
    /** Idempotency key supplied by the request or message producer. */
    idempotencyKey: p.text().fieldName('idempotency_key'),
    /** Hash of the original payload used to detect conflicting retries. */
    payloadHash: p.text().fieldName('payload_hash'),
    /** Wallet affected by the transaction. */
    wallet: p.manyToOne(WalletEntity).fieldName('wallet_id'),
    /** Player associated with the transaction payload. */
    playerId: p.text().fieldName('player_id'),
    /** Game round associated with the transaction, when provided. */
    roundId: p.text().fieldName('round_id'),
    /** Game associated with the transaction. */
    gameId: p.text().fieldName('game_id'),
    /** Financial operation type, such as BET, WIN, REFUND, or ROLLBACK. */
    kind: p
      .text()
      .check(
        `"kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')`,
      ),
    /** Positive transaction amount stored with exact decimal precision. */
    amount: p.decimal('string').precision(20).scale(2).check('"amount" > 0'),
    /** ISO-4217 currency code used by the transaction. */
    currency: p.string().length(3).check(`"currency" ~ '^[A-Z]{3}$'`),
    /** External transaction required to justify refunds and rollbacks. */
    referenceExternalTransactionId: p
      .text()
      .fieldName('reference_external_transaction_id')
      .nullable()
      .check(
        `"kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null`,
      ),
    /** Internal transaction reference when the related transaction is known. */
    referenceTransactionId: p
      .text()
      .fieldName('reference_transaction_id')
      .nullable(),
    /** Processing state used by workers and retry flows. */
    status: p
      .text()
      .default('PENDING')
      .check(
        `"status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')`,
      ),
    /** Failure reason required when processing is rejected or fails. */
    failureCode: p
      .text()
      .fieldName('failure_code')
      .nullable()
      .check(
        `"status" not in ('REJECTED', 'FAILED') or "failure_code" is not null`,
      ),
    /** Time at which the transaction row was created. */
    createdAt: p.datetime().fieldName('created_at').defaultRaw('now()'),
    /** Time at which successful processing completed. */
    processedAt: p
      .datetime()
      .fieldName('processed_at')
      .nullable()
      .check(`"status" <> 'PROCESSED' or "processed_at" is not null`),
    referenceAttempts: p
      .integer()
      .fieldName('reference_attempts')
      .default(0)
      .check('"reference_attempts" >= 0'),
    nextReferenceAttemptAt: p
      .datetime()
      .fieldName('next_reference_attempt_at')
      .nullable(),
    /** Balance returned when the transaction was first processed. */
    resultBalanceAmount: p
      .decimal('string')
      .fieldName('result_balance_amount')
      .precision(20)
      .scale(2)
      .nullable(),
    /** Currency of the original response balance snapshot. */
    resultBalanceCurrency: p
      .string()
      .length(3)
      .fieldName('result_balance_currency')
      .nullable(),
    /** Wallet version observed in the original response. */
    resultWalletVersion: p
      .integer()
      .fieldName('result_wallet_version')
      .nullable()
      .check('"result_wallet_version" is null or "result_wallet_version" >= 1'),
  },
  uniques: [
    {
      /** Guarantees provider transaction identity is processed only once. */
      name: 'wager_transactions_provider_external_unique',
      properties: ['providerId', 'externalTransactionId'],
    },
    {
      /** Guarantees a repeated idempotency key addresses one transaction. */
      name: 'wager_transactions_idempotency_unique',
      properties: ['idempotencyKey'],
    },
  ],
  indexes: [
    {
      /** Speeds up workers searching wallet transactions by processing state. */
      name: 'wager_transactions_wallet_status_idx',
      properties: ['wallet', 'status'],
    },
    {
      name: 'wager_transactions_reference_retry_idx',
      properties: ['status', 'nextReferenceAttemptAt'],
    },
  ],
});
