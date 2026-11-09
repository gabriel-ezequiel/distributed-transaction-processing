import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  WagerMessageTransport,
  WagerTransactionConsumer,
  WagerTransactionMessage,
} from '../../application/messaging/wager-transaction-consumer.js';

/** SQS configuration for the wagering queue and its dead-letter queue. */
export interface SqsWagerQueueConfig {
  /** Main queue name. */
  queueName: string;
  /** Dead-letter queue name. */
  deadLetterQueueName: string;
  /** Visibility timeout for one processing attempt. */
  visibilityTimeoutSeconds: number;
  /** Maximum receives before SQS redrive to the DLQ. */
  maxReceiveCount: number;
  /** Whether the queues use FIFO semantics. */
  fifo?: boolean;
}

/**
 * Creates and configures the main queue and DLQ.
 */
export class SqsWagerQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly config: SqsWagerQueueConfig,
  ) {
    if (
      !config.queueName.trim() ||
      !config.deadLetterQueueName.trim() ||
      config.queueName === config.deadLetterQueueName
    ) {
      throw new Error('SQS queue names must be distinct and non-empty');
    }
    if (
      !Number.isInteger(config.visibilityTimeoutSeconds) ||
      config.visibilityTimeoutSeconds < 1 ||
      !Number.isInteger(config.maxReceiveCount) ||
      config.maxReceiveCount < 1
    ) {
      throw new Error('SQS queue limits must be positive integers');
    }
  }

  /** Ensures both queues exist and configures the main queue redrive policy. */
  async ensureQueues(): Promise<{
    queueUrl: string;
    deadLetterQueueUrl: string;
  }> {
    const deadLetterQueueUrl = await this.createQueue(
      this.config.deadLetterQueueName,
    );
    const deadLetterAttributes = await this.client.send(
      new GetQueueUrlCommand({ QueueName: this.config.deadLetterQueueName }),
    );
    const queueUrl = await this.createQueue(this.config.queueName, {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: await this.getQueueArn(
          deadLetterAttributes.QueueUrl,
        ),
        maxReceiveCount: String(this.config.maxReceiveCount),
      }),
    });
    return { queueUrl, deadLetterQueueUrl };
  }

  /** Receives one batch with long polling and the configured visibility timeout. */
  async receive(queueUrl: string): Promise<Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        VisibilityTimeout: this.config.visibilityTimeoutSeconds,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return response.Messages ?? [];
  }

  private async createQueue(
    queueName: string,
    attributes?: Record<string, string>,
  ): Promise<string> {
    const response = await this.client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          ...(this.config.fifo
            ? { FifoQueue: 'true', ContentBasedDeduplication: 'false' }
            : {}),
          ...attributes,
        },
      }),
    );
    if (!response.QueueUrl) {
      throw new Error(`SQS did not return a URL for queue ${queueName}`);
    }
    return response.QueueUrl;
  }

  private async getQueueArn(queueUrl?: string): Promise<string> {
    if (!queueUrl) {
      throw new Error('SQS did not return the dead-letter queue URL');
    }
    const attributes = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const arn = attributes.Attributes?.QueueArn;
    if (!arn) {
      throw new Error('SQS did not return the dead-letter queue ARN');
    }
    return arn;
  }
}

/**
 * SQS adapter implementing the consumer transport contract.
 */
export class SqsWagerTransport implements WagerMessageTransport {
  private readonly receipts = new WeakMap<
    WagerTransactionMessage,
    { receiptHandle: string; queueUrl: string }
  >();

  constructor(
    private readonly client: SQSClient,
    private queueUrl: string,
    private deadLetterQueueUrl: string,
    private readonly visibilityTimeoutSeconds: number,
  ) {}

  /** Sets queue URLs after startup queue discovery completes. */
  configure(queueUrl: string, deadLetterQueueUrl: string): void {
    this.queueUrl = queueUrl;
    this.deadLetterQueueUrl = deadLetterQueueUrl;
  }

  /** Converts an AWS message into the domain-neutral message envelope. */
  parse(message: Message): WagerTransactionMessage {
    if (!message.MessageId || !message.ReceiptHandle || !message.Body) {
      throw new Error('SQS message is missing ID, receipt handle, or body');
    }
    const parsed: unknown = JSON.parse(message.Body);
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('SQS message body must be an object');
    }
    const envelope = parsed as Omit<WagerTransactionMessage, 'messageId'>;
    const result = {
      ...envelope,
      messageId: message.MessageId,
    } as WagerTransactionMessage;
    this.receipts.set(result, {
      receiptHandle: message.ReceiptHandle,
      queueUrl: this.queueUrl,
    });
    return result;
  }

  /** Deletes the message after the database transaction has committed. */
  async ack(message: WagerTransactionMessage): Promise<void> {
    const receipt = this.requireReceipt(message);
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: receipt.queueUrl,
        ReceiptHandle: receipt.receiptHandle,
      }),
    );
  }

  /** Extends visibility briefly so a transient failure can be redelivered. */
  async retry(message: WagerTransactionMessage): Promise<void> {
    const receipt = this.requireReceipt(message);
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: receipt.queueUrl,
        ReceiptHandle: receipt.receiptHandle,
        VisibilityTimeout: Math.min(this.visibilityTimeoutSeconds, 1),
      }),
    );
  }

  /** Publishes permanent failures to the configured DLQ and removes the source message. */
  async deadLetter(
    message: WagerTransactionMessage,
    reason: string,
  ): Promise<void> {
    this.requireReceipt(message);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.deadLetterQueueUrl,
        ...(this.deadLetterQueueUrl.endsWith('.fifo')
          ? {
              MessageGroupId: message.data.walletId,
              MessageDeduplicationId: message.messageId,
            }
          : {}),
        MessageBody: JSON.stringify({
          ...message,
          failureReason: reason,
        }),
      }),
    );
    await this.ack(message);
  }

  private requireReceipt(message: WagerTransactionMessage): {
    receiptHandle: string;
    queueUrl: string;
  } {
    const receipt = this.receipts.get(message);
    if (!receipt) {
      throw new Error(`SQS receipt not found for ${message.messageId}`);
    }
    return receipt;
  }
}

/** Long-polling worker that drains SQS until shutdown is requested. */
export class SqsWagerConsumerWorker {
  private stopping = false;

  constructor(
    private readonly queue: SqsWagerQueue,
    private readonly transport: SqsWagerTransport,
    private readonly consumer: WagerTransactionConsumer,
  ) {}

  /** Starts polling and stops after the current batch when shutdown is requested. */
  async run(): Promise<void> {
    const { queueUrl, deadLetterQueueUrl } = await this.queue.ensureQueues();
    this.transport.configure(queueUrl, deadLetterQueueUrl);
    while (!this.stopping) {
      const messages = await this.queue.receive(queueUrl);
      await Promise.all(
        messages.map(async (message) => {
          const parsed = this.transport.parse(message);
          const attempt = Number(
            message.Attributes?.ApproximateReceiveCount ?? '1',
          );
          await this.consumer.handle(parsed, attempt);
        }),
      );
    }
  }

  /** Requests graceful shutdown after in-flight handlers complete. */
  stop(): void {
    this.stopping = true;
  }
}
