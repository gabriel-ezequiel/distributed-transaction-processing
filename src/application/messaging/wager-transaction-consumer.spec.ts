import { describe, expect, it, vi } from 'vitest';
import {
  WagerMessageDisposition,
  WagerMessageTransport,
  WagerTransactionConsumer,
  WagerTransactionMessage,
} from './wager-transaction-consumer.js';
import { ProcessWagerTransaction } from '../wagering/process-wager-transaction.js';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction.js';

const message: WagerTransactionMessage = {
  messageId: 'message-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-01-01T00:00:00.000Z',
  data: {
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'key-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  },
};

function createTransport(): WagerMessageTransport {
  return {
    ack: vi.fn(),
    retry: vi.fn(),
    deadLetter: vi.fn(),
  };
}

describe('WagerTransactionConsumer', () => {
  it('acks only after the shared use case resolves', async () => {
    // Resolving the use case represents a committed database transaction.
    const transport = createTransport();
    const process = {
      execute: vi.fn().mockResolvedValue({
        transactionId: 'transaction-1',
        status: 'PROCESSED',
        idempotentReplay: false,
      }),
    } as unknown as ProcessWagerTransaction;
    const consumer = new WagerTransactionConsumer(
      process,
      transport,
      'wager-consumer',
    );

    const result = await consumer.handle(message);

    expect(result.disposition).toBe(WagerMessageDisposition.Ack);
    expect(process.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-1',
        consumerName: 'wager-consumer',
      }),
    );
    expect(transport.ack).toHaveBeenCalledWith(message);
  });

  it('retries transient failures before the attempt limit', async () => {
    // A temporary database or broker failure must not be acknowledged.
    const transport = createTransport();
    const process = {
      execute: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as ProcessWagerTransaction;
    const consumer = new WagerTransactionConsumer(
      process,
      transport,
      'wager-consumer',
      3,
    );

    const result = await consumer.handle(message, 1);

    expect(result.disposition).toBe(WagerMessageDisposition.Retry);
    expect(transport.retry).toHaveBeenCalledWith(message);
    expect(transport.ack).not.toHaveBeenCalled();
  });

  it('sends invalid messages to the dead-letter queue', async () => {
    // Unsupported schemas cannot succeed on redelivery and are permanent failures.
    const transport = createTransport();
    const process = {
      execute: vi.fn(),
    } as unknown as ProcessWagerTransaction;
    const consumer = new WagerTransactionConsumer(
      process,
      transport,
      'wager-consumer',
    );

    const result = await consumer.handle({
      ...message,
      type: 'UnknownMessage',
    });

    expect(result.disposition).toBe(WagerMessageDisposition.DeadLetter);
    expect(transport.deadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message-1' }),
      'Unsupported message type: UnknownMessage',
    );
    expect(process.execute).not.toHaveBeenCalled();
  });
});
