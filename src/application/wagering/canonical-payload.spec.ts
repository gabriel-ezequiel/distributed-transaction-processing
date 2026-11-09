import { describe, expect, it } from 'vitest';
import {
  canonicalizeWagerPayload,
  hashCanonicalWagerPayload,
} from './canonical-payload.js';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction.js';

describe('canonical wager payload', () => {
  it('orders nested business keys deterministically', () => {
    // Key ordering must not change the payload identity used for idempotency.
    const first = canonicalizeWagerPayload({
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet as WagerTransactionKind.Bet,
      money: { currency: 'BRL', amount: '10.00' },
    });
    const second = canonicalizeWagerPayload({
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(first).toBe(second);
    expect(hashCanonicalWagerPayload(JSON.parse(first))).toBe(
      hashCanonicalWagerPayload(JSON.parse(second)),
    );
  });

  it('does not include transport idempotency metadata', () => {
    // The header identifies the record, while only business data identifies its payload.
    const payload: Parameters<typeof canonicalizeWagerPayload>[0] = {
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };

    expect(canonicalizeWagerPayload(payload)).not.toContain('idempotency');
  });
});
