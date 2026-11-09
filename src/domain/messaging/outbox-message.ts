import { IntegrationEvent } from './integration-event.js';

/**
 * State required to rebuild a persisted outbox message.
 */
export interface OutboxMessageState {
  /** Unique event identifier. */
  id: string;
  /** Aggregate that emitted the event. */
  aggregateId: string;
  /** Event name and schema version are stored in the payload envelope. */
  eventType: string;
  /** Serialized integration event payload. */
  payload: Readonly<Record<string, unknown>>;
  /** Time at which the event occurred. */
  occurredAt: Date;
  /** Number of failed publish attempts. */
  attempts: number;
  /** Earliest time at which retry is allowed. */
  nextAttemptAt?: Date;
  /** Successful publication time. */
  publishedAt?: Date;
}

/**
 * Durable event waiting to be published by an outbox worker.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    private readonly _occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** Creates an unpublished outbox record from a typed integration event. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
    );
  }

  /** Rebuilds persisted outbox state without changing retry counters. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    OutboxMessage.assertText(state.id, 'id');
    OutboxMessage.assertText(state.aggregateId, 'aggregateId');
    OutboxMessage.assertText(state.eventType, 'eventType');
    OutboxMessage.assertDate(state.occurredAt, 'occurredAt');
    if (!Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new InvalidOutboxMessageError(
        'attempts must be a non-negative integer',
      );
    }
    if (state.nextAttemptAt !== undefined) {
      OutboxMessage.assertDate(state.nextAttemptAt, 'nextAttemptAt');
    }
    if (state.publishedAt !== undefined) {
      OutboxMessage.assertDate(state.publishedAt, 'publishedAt');
    }

    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined,
      state.publishedAt ? new Date(state.publishedAt) : undefined,
    );
  }

  /** Returns the original occurrence timestamp. */
  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  /** Returns the number of failed publication attempts. */
  get attempts(): number {
    return this._attempts;
  }

  /** Returns the next eligible retry time, if a retry was scheduled. */
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt) : undefined;
  }

  /** Returns the publication timestamp, if the event was published. */
  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt) : undefined;
  }

  /** Indicates that the event has not been published yet. */
  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Indicates whether a pending event can be attempted at the given time. */
  isDue(now: Date): boolean {
    OutboxMessage.assertDate(now, 'now');
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt <= now)
    );
  }

  /** Marks the event published after the broker confirms acceptance. */
  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageError(
        'Outbox message is already published',
      );
    }
    OutboxMessage.assertDate(at, 'publishedAt');
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  /**
   * Increments the attempt counter and applies exponential backoff.
   *
   * The first retry is one second after the failure; each later retry doubles
   * that delay.
   */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageError(
        'Published outbox messages cannot be retried',
      );
    }
    OutboxMessage.assertDate(now, 'now');
    this._attempts += 1;
    this._nextAttemptAt = new Date(
      now.getTime() + 1000 * 2 ** (this._attempts - 1),
    );
  }

  private static assertText(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidOutboxMessageError(`${field} must not be empty`);
    }
  }

  private static assertDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidOutboxMessageError(`${field} must be a valid date`);
    }
  }
}

/** Raised when an outbox message is invalid or has an invalid transition. */
export class InvalidOutboxMessageError extends Error {
  /** Creates an error for invalid outbox state. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutboxMessageError';
  }
}
