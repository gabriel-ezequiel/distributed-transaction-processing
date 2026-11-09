import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { OnModuleDestroy, OnModuleInit, Injectable } from '@nestjs/common';
import { OutboxPublisher } from '../../application/messaging/outbox-publisher.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export class SqsOutboxEventPublisher {
  private queueUrl?: string;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {
    if (!queueName.trim()) {
      throw new Error('Outbox queue name must not be empty');
    }
  }

  async ensureQueue(): Promise<void> {
    const response = await this.client.send(
      new CreateQueueCommand({
        QueueName: this.queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
        },
      }),
    );
    if (!response.QueueUrl) {
      throw new Error(`SQS did not return a URL for ${this.queueName}`);
    }
    this.queueUrl = response.QueueUrl;
  }

  async publish(message: OutboxMessage): Promise<void> {
    const queueUrl =
      this.queueUrl ??
      (
        await this.client.send(
          new GetQueueUrlCommand({ QueueName: this.queueName }),
        )
      ).QueueUrl;
    if (!queueUrl) {
      throw new Error(`SQS did not return a URL for ${this.queueName}`);
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }
}

@Injectable()
export class OutboxPublisherLifecycle implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly publisher: OutboxPublisher,
    private readonly broker: SqsOutboxEventPublisher,
  ) {}

  onModuleInit(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED !== 'true') {
      return;
    }
    const interval = Number(process.env.OUTBOX_PUBLISHER_INTERVAL_MS ?? 1000);
    if (!Number.isInteger(interval) || interval < 100) {
      throw new Error('OUTBOX_PUBLISHER_INTERVAL_MS must be at least 100');
    }
    this.timer = setInterval(() => {
      void this.publishOnce();
    }, interval);
    void this.publishOnce();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async publishOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.broker.ensureQueue();
      await this.publisher.publishBatch();
    } catch (error: unknown) {
      process.stderr.write(
        `Outbox publisher failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    } finally {
      this.running = false;
    }
  }
}
