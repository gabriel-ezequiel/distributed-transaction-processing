import { describe, expect, it, vi } from 'vitest';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsWagerTransport, SqsWagerQueue } from './sqs-wager-transport.js';

const body = JSON.stringify({
  messageId: 'body-id',
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
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  },
});

function createClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
  } as unknown as SQSClient & { send: ReturnType<typeof vi.fn> };
}

describe('SqsWagerTransport', () => {
  it('parses an AWS message and preserves the transport receipt', async () => {
    // The receipt is kept private so only the transport can acknowledge it.
    const client = createClient();
    const transport = new SqsWagerTransport(client, 'main-url', 'dlq-url', 30);

    const message = transport.parse({
      MessageId: 'message-1',
      ReceiptHandle: 'receipt-1',
      Body: body,
    });
    await transport.ack(message);

    expect(message.messageId).toBe('message-1');
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0]?.[0].input).toMatchObject({
      QueueUrl: 'main-url',
      ReceiptHandle: 'receipt-1',
    });
  });

  it('changes visibility for retry and publishes permanent failures to the DLQ', async () => {
    // Retry keeps the source message available; DLQ removes it only after send succeeds.
    const client = createClient();
    const transport = new SqsWagerTransport(client, 'main-url', 'dlq-url', 30);
    const message = transport.parse({
      MessageId: 'message-1',
      ReceiptHandle: 'receipt-1',
      Body: body,
    });

    await transport.retry(message);
    await transport.deadLetter(message, 'invalid payload');

    expect(client.send).toHaveBeenCalledTimes(3);
    expect(client.send.mock.calls[0]?.[0].input).toMatchObject({
      QueueUrl: 'main-url',
      VisibilityTimeout: 1,
    });
    expect(client.send.mock.calls[1]?.[0].input).toMatchObject({
      QueueUrl: 'dlq-url',
      MessageBody: expect.stringContaining('invalid payload'),
    });
  });
});

describe('SqsWagerQueue', () => {
  it('rejects invalid queue configuration before contacting AWS', () => {
    // Invalid operational limits should fail during application startup.
    expect(
      () =>
        new SqsWagerQueue(createClient(), {
          queueName: 'wager-transactions.fifo',
          deadLetterQueueName: 'wager-transactions.fifo',
          visibilityTimeoutSeconds: 30,
          maxReceiveCount: 5,
        }),
    ).toThrow('distinct and non-empty');
  });
});
