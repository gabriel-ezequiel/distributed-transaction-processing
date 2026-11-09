/**
 * Properties required to create a versioned integration event envelope.
 */
export interface IntegrationEventProps<T> {
  /** Unique identifier of this event occurrence. */
  eventId: string;
  /** Identifier of the aggregate that emitted the event. */
  aggregateId: string;
  /** Identifier shared by all events in one operation. */
  correlationId: string;
  /** Optional identifier of the event or command that caused this event. */
  causationId?: string;
  /** Time at which the domain event occurred. */
  occurredAt: Date;
  /** Versioned event data. */
  data: T;
}

/**
 * Base envelope for integration events persisted in the transactional outbox.
 *
 * Concrete events define their own event type and version, preventing callers
 * from accidentally publishing an unsupported string or schema version.
 */
export abstract class IntegrationEvent<T> {
  /** Concrete event name used by subscribers. */
  abstract readonly eventType: string;

  /** Concrete event schema version. */
  abstract readonly version: number;

  /** Unique event identifier. */
  public readonly eventId: string;
  /** Aggregate identifier associated with the event. */
  public readonly aggregateId: string;
  /** Correlation identifier for tracing the operation. */
  public readonly correlationId: string;
  /** Optional causation identifier. */
  public readonly causationId: string | undefined;
  private readonly _occurredAt: Date;
  /** Immutable event data. */
  public readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    IntegrationEvent.assertIdentifier(props.eventId, 'eventId');
    IntegrationEvent.assertIdentifier(props.aggregateId, 'aggregateId');
    IntegrationEvent.assertIdentifier(props.correlationId, 'correlationId');
    if (props.causationId !== undefined) {
      IntegrationEvent.assertIdentifier(props.causationId, 'causationId');
    }
    if (
      !(props.occurredAt instanceof Date) ||
      Number.isNaN(props.occurredAt.getTime())
    ) {
      throw new InvalidIntegrationEventError('occurredAt must be a valid date');
    }
    if (props.data === null || typeof props.data !== 'object') {
      throw new InvalidIntegrationEventError('data must be an object');
    }

    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this._occurredAt = new Date(props.occurredAt);
    this.data = props.data;
  }

  /** Returns a defensive copy of the event timestamp. */
  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  /** Serializes the event into the stable payload stored by the outbox. */
  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
  } {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }

  private static assertIdentifier(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidIntegrationEventError(`${field} must not be empty`);
    }
  }
}

/** Raised when an integration event envelope is structurally invalid. */
export class InvalidIntegrationEventError extends Error {
  /** Creates an error for invalid event data. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIntegrationEventError';
  }
}
