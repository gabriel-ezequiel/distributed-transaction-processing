import { OutboxMessage } from '../../domain/messaging/outbox-message.js';

/**
 * Minimal broker port. The promise resolves only after the broker confirms
 * acceptance of the event.
 */
export interface IntegrationEventPublisher {
  /** Publishes one serialized event envelope. */
  publish(message: OutboxMessage): Promise<void>;
}

/** Transaction-scoped persistence port for the outbox worker. */
export interface OutboxPublisherStore {
  /** Locks due rows until the surrounding database transaction finishes. */
  findDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persists publication or retry state for a locked row. */
  save(message: OutboxMessage): Promise<void>;
}

/** Unit-of-work port used to coordinate broker confirmation and outbox state. */
export interface OutboxPublisherUnitOfWork {
  transactional<T>(
    work: (store: OutboxPublisherStore) => Promise<T>,
  ): Promise<T>;
}

/**
 * Publishes pending events with database locking and exponential retry.
 *
 * A broker acknowledgement is required before `publishedAt` is persisted.
 * If the process crashes after broker acceptance and before commit, the event
 * can be delivered again; consumers must therefore deduplicate by event ID.
 */
export class OutboxPublisher {
  constructor(
    private readonly unitOfWork: OutboxPublisherUnitOfWork,
    private readonly broker: IntegrationEventPublisher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Publishes one batch and returns the number of successfully confirmed events. */
  async publishBatch(limit = 50): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Outbox batch limit must be a positive integer');
    }

    return this.unitOfWork.transactional(async (store) => {
      const now = this.clock();
      const messages = await store.findDue(now, limit);
      let published = 0;

      for (const message of messages) {
        try {
          await this.broker.publish(message);
          message.markPublished(this.clock());
          await store.save(message);
          published += 1;
        } catch (error) {
          message.scheduleRetry(this.clock());
          await store.save(message);
          if (!(error instanceof Error)) {
            throw new Error('Outbox broker failed with a non-Error value');
          }
        }
      }

      return published;
    });
  }
}
