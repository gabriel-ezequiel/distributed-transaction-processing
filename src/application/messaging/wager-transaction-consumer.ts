import { InvalidMoneyError } from '../../domain/money/money.js';
import {
  IdempotencyConflictError,
  ProcessWagerTransaction,
  ProcessWagerTransactionCommand,
  WagerTransactionNotFoundError,
} from '../wagering/process-wager-transaction.js';
import { hashCanonicalWagerPayload } from '../wagering/canonical-payload.js';

/**
 * Transport-neutral representation of an SQS message.
 */
export interface WagerTransactionMessage {
  /** Transport message identifier used by the Inbox. */
  messageId: string;
  /** Message type used to reject unsupported payloads. */
  type: string;
  /** Message creation timestamp. */
  occurredAt: string;
  /** Provider transaction command data. */
  data: Omit<
    ProcessWagerTransactionCommand,
    | 'payloadHash'
    | 'correlationId'
    | 'messageId'
    | 'consumerName'
    | 'occurredAt'
  >;
}

/**
 * Minimal broker port required by the consumer.
 */
export interface WagerMessageTransport {
  /** Acknowledges a message after the database transaction has committed. */
  ack(message: WagerTransactionMessage): Promise<void>;
  /** Returns a transiently failed message to the queue. */
  retry(message: WagerTransactionMessage): Promise<void>;
  /** Sends a permanently failed message to the dead-letter queue. */
  deadLetter(message: WagerTransactionMessage, reason: string): Promise<void>;
}

/** Error categories used to decide ack, retry, or DLQ behavior. */
export enum WagerMessageDisposition {
  /** Business decision or successful processing; the message is acknowledged. */
  Ack = 'ACK',
  /** Temporary infrastructure issue; the broker should redeliver. */
  Retry = 'RETRY',
  /** Invalid or permanently unprocessable message; send to DLQ. */
  DeadLetter = 'DEAD_LETTER',
}

/** Result of handling one transport message. */
export interface WagerMessageHandlingResult {
  /** Action performed on the transport. */
  disposition: WagerMessageDisposition;
  /** Financial result, when the use case was invoked successfully. */
  transactionStatus?: string;
}

/**
 * SQS-compatible consumer coordinator.
 *
 * The use case owns the Inbox write and financial transaction. This class
 * acknowledges only after `execute` resolves, which means the SQL commit has
 * completed.
 */
export class WagerTransactionConsumer {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly transport: WagerMessageTransport,
    private readonly consumerName: string,
    private readonly maxAttempts = 5,
  ) {
    if (!consumerName.trim()) {
      throw new Error('Consumer name must not be empty');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('Maximum attempts must be a positive integer');
    }
  }

  /** Handles one message and applies the correct broker disposition. */
  async handle(
    message: WagerTransactionMessage,
    attempt = 1,
  ): Promise<WagerMessageHandlingResult> {
    try {
      const command = this.toCommand(message);
      const result = await this.processWagerTransaction.execute(command);
      await this.transport.ack(message);
      return {
        disposition: WagerMessageDisposition.Ack,
        transactionStatus: result.status,
      };
    } catch (error) {
      const disposition = this.classify(error, attempt);
      if (disposition === WagerMessageDisposition.DeadLetter) {
        await this.transport.deadLetter(message, this.reason(error));
      } else if (disposition === WagerMessageDisposition.Retry) {
        await this.transport.retry(message);
      } else {
        await this.transport.ack(message);
      }
      return { disposition };
    }
  }

  private toCommand(
    message: WagerTransactionMessage,
  ): ProcessWagerTransactionCommand {
    if (message.type !== 'WagerTransactionRequested') {
      throw new PermanentWagerMessageError(
        `Unsupported message type: ${message.type}`,
      );
    }
    const occurredAt = new Date(message.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new PermanentWagerMessageError('Message occurredAt is invalid');
    }

    return {
      ...message.data,
      payloadHash: hashCanonicalWagerPayload(message.data),
      correlationId: message.data.idempotencyKey,
      messageId: message.messageId,
      consumerName: this.consumerName,
      occurredAt,
    };
  }

  private classify(error: unknown, attempt: number): WagerMessageDisposition {
    if (
      error instanceof InvalidMoneyError ||
      error instanceof IdempotencyConflictError ||
      error instanceof PermanentWagerMessageError
    ) {
      return WagerMessageDisposition.DeadLetter;
    }
    if (error instanceof WagerTransactionNotFoundError) {
      return attempt >= this.maxAttempts
        ? WagerMessageDisposition.DeadLetter
        : WagerMessageDisposition.Retry;
    }
    return attempt >= this.maxAttempts
      ? WagerMessageDisposition.DeadLetter
      : WagerMessageDisposition.Retry;
  }

  private reason(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown consumer failure';
  }
}

/** Raised for a message that cannot become a valid financial command. */
export class PermanentWagerMessageError extends Error {
  /** Creates a permanent message validation failure. */
  constructor(message: string) {
    super(message);
    this.name = 'PermanentWagerMessageError';
  }
}
