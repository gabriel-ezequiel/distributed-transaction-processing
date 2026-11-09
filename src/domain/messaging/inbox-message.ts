/**
 * State required to rebuild a persisted inbox message.
 */
export interface InboxMessageState {
  /** Transport message identifier. */
  messageId: string;
  /** Consumer-specific deduplication boundary. */
  consumerName: string;
  /** Hash of the received payload. */
  payloadHash: string;
  /** Time at which the message was received. */
  receivedAt: Date;
  /** Completion time, when processing has succeeded. */
  processedAt?: Date;
}

/**
 * Durable idempotency record for an incoming message.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  /** Receives a new message in an unprocessed state. */
  static receive(props: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    InboxMessage.assertText(props.messageId, 'messageId');
    InboxMessage.assertText(props.consumerName, 'consumerName');
    InboxMessage.assertText(props.payloadHash, 'payloadHash');
    InboxMessage.assertDate(props.receivedAt, 'receivedAt');

    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(props.receivedAt),
    );
  }

  /** Rebuilds an inbox record without replaying its lifecycle transition. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    const message = InboxMessage.receive(state);
    if (state.processedAt !== undefined) {
      message.markProcessed(state.processedAt);
    }
    return message;
  }

  /** Returns the receive timestamp without exposing mutable state. */
  get receivedAt(): Date {
    return new Date(this._receivedAt);
  }

  /** Returns the completion timestamp without exposing mutable state. */
  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  /** Indicates whether processing has completed successfully. */
  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Marks the message processed within the surrounding atomic transaction. */
  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxMessageError('Inbox message is already processed');
    }
    InboxMessage.assertDate(at, 'processedAt');
    this._processedAt = new Date(at);
  }

  private static assertText(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidInboxMessageError(`${field} must not be empty`);
    }
  }

  private static assertDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidInboxMessageError(`${field} must be a valid date`);
    }
  }
}

/** Raised when an inbox message is invalid or has an invalid transition. */
export class InvalidInboxMessageError extends Error {
  /** Creates an error for invalid inbox state. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInboxMessageError';
  }
}
