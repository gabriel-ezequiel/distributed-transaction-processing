import { createHash } from 'node:crypto';
import type { ProcessWagerTransactionCommand } from './process-wager-transaction.js';

/**
 * Produces deterministic JSON by sorting object keys recursively.
 *
 * Transport metadata such as idempotency and correlation headers is deliberately
 * excluded by accepting only the business fields used by the command.
 */
export function canonicalizeWagerPayload(
  payload: Pick<
    ProcessWagerTransactionCommand,
    | 'providerId'
    | 'externalTransactionId'
    | 'playerId'
    | 'walletId'
    | 'roundId'
    | 'gameId'
    | 'kind'
    | 'money'
    | 'referenceExternalTransactionId'
  >,
): string {
  return JSON.stringify(sortKeys(payload));
}

/** Hashes the canonical payload with SHA-256 for durable replay comparison. */
export function hashCanonicalWagerPayload(
  payload: Parameters<typeof canonicalizeWagerPayload>[0],
): string {
  return createHash('sha256')
    .update(canonicalizeWagerPayload(payload))
    .digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    );
  }
  return value;
}
