import {
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SqsWagerQueue,
  SqsWagerTransport,
} from '../src/infrastructure/messaging/sqs-wager-transport.js';

describe('MiniStack SQS integration', () => {
  const suffix = randomUUID();
  const queueName = `e2e-wager-${suffix}.fifo`;
  const deadLetterQueueName = `e2e-wager-dlq-${suffix}.fifo`;
  const client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  let queueUrl = '';
  let deadLetterQueueUrl = '';

  beforeAll(async () => {
    const queues = new SqsWagerQueue(client, {
      queueName,
      deadLetterQueueName,
      visibilityTimeoutSeconds: 1,
      maxReceiveCount: 3,
      fifo: true,
    });
    ({ queueUrl, deadLetterQueueUrl } = await queues.ensureQueues());
  });

  afterAll(async () => {
    await Promise.all(
      [queueUrl, deadLetterQueueUrl]
        .filter(Boolean)
        .map((QueueUrl) => client.send(new DeleteQueueCommand({ QueueUrl }))),
    );
    client.destroy();
  });

  it('receives and acknowledges a FIFO message', async () => {
    const messageId = randomUUID();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageGroupId: 'wallet-e2e',
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'e2e-provider',
            externalTransactionId: messageId,
            idempotencyKey: messageId,
            walletId: 'wallet-e2e',
            playerId: 'player-e2e',
            roundId: 'round-e2e',
            gameId: 'game-e2e',
            kind: 'BET',
            money: { amount: '1.00', currency: 'BRL' },
          },
        }),
      }),
    );
    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 2,
        MaxNumberOfMessages: 1,
      }),
    );
    const message = received.Messages?.[0];
    expect(message?.Body).toContain(messageId);

    const transport = new SqsWagerTransport(
      client,
      queueUrl,
      deadLetterQueueUrl,
      1,
    );
    const parsed = transport.parse(message!);
    await transport.ack(parsed);

    const empty = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(empty.Messages ?? []).toHaveLength(0);
  });

  it('publishes a permanent failure to the real DLQ', async () => {
    const messageId = randomUUID();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageGroupId: 'wallet-dlq-e2e',
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({ invalid: true }),
      }),
    );
    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 2,
        MaxNumberOfMessages: 1,
      }),
    );
    const message = received.Messages?.[0];
    expect(message).toBeDefined();

    const transport = new SqsWagerTransport(
      client,
      queueUrl,
      deadLetterQueueUrl,
      1,
    );
    const parsed = transport.parse({
      ...message!,
      Body: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          walletId: 'wallet-dlq-e2e',
          providerId: 'e2e-provider',
          externalTransactionId: messageId,
          idempotencyKey: messageId,
          playerId: 'player-e2e',
          roundId: 'round-e2e',
          gameId: 'game-e2e',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        },
      }),
    });
    await transport.deadLetter(parsed, 'permanent test failure');

    const deadLetter = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        WaitTimeSeconds: 2,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(deadLetter.Messages?.[0]?.Body).toContain('permanent test failure');
  });

  it('redelivers a message after a real visibility retry', async () => {
    const messageId = randomUUID();
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageGroupId: 'wallet-retry-e2e',
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            walletId: 'wallet-retry-e2e',
            providerId: 'e2e-provider',
            externalTransactionId: messageId,
            idempotencyKey: messageId,
            playerId: 'player-e2e',
            roundId: 'round-e2e',
            gameId: 'game-e2e',
            kind: 'BET',
            money: { amount: '1.00', currency: 'BRL' },
          },
        }),
      }),
    );
    const firstReceive = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 2,
        MaxNumberOfMessages: 1,
      }),
    );
    const first = firstReceive.Messages?.[0];
    expect(first).toBeDefined();
    const transport = new SqsWagerTransport(
      client,
      queueUrl,
      deadLetterQueueUrl,
      1,
    );
    const parsed = transport.parse(first!);
    await transport.retry(parsed);

    const secondReceive = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 3,
        MaxNumberOfMessages: 1,
      }),
    );
    const second = secondReceive.Messages?.[0];
    expect(second?.MessageId).toBe(first?.MessageId);
    await transport.ack(transport.parse(second!));
  });
});
