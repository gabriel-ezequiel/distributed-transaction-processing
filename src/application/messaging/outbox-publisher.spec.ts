import { describe, expect, it } from 'vitest';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import {
  IntegrationEvent,
  IntegrationEventProps,
} from '../../domain/messaging/integration-event.js';
import {
  IntegrationEventPublisher,
  OutboxPublisher,
  OutboxPublisherStore,
  OutboxPublisherUnitOfWork,
} from './outbox-publisher.js';

class TestEvent extends IntegrationEvent<{ value: string }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;

  constructor(props: IntegrationEventProps<{ value: string }>) {
    super(props);
  }
}

class FakeStore implements OutboxPublisherStore {
  constructor(readonly messages: OutboxMessage[]) {}

  async findDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    return this.messages
      .filter((message) => message.isDue(now))
      .slice(0, limit);
  }

  async save(_message: OutboxMessage): Promise<void> {}
}

class FakeUnitOfWork implements OutboxPublisherUnitOfWork {
  constructor(readonly store: FakeStore) {}

  async transactional<T>(
    work: (store: OutboxPublisherStore) => Promise<T>,
  ): Promise<T> {
    return work(this.store);
  }
}

class FakeBroker implements IntegrationEventPublisher {
  readonly published: string[] = [];
  shouldFail = false;

  async publish(message: OutboxMessage): Promise<void> {
    if (this.shouldFail) {
      throw new Error('broker unavailable');
    }
    this.published.push(message.id);
  }
}

function createMessage(): OutboxMessage {
  return OutboxMessage.enqueue(
    new TestEvent({
      eventId: 'event-1',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      data: { value: 'sample' },
    }),
  );
}

describe('OutboxPublisher', () => {
  it('marks a message published only after broker confirmation', async () => {
    // The durable publication marker follows broker acknowledgement.
    const message = createMessage();
    const broker = new FakeBroker();
    const publisher = new OutboxPublisher(
      new FakeUnitOfWork(new FakeStore([message])),
      broker,
      () => new Date('2026-01-01T00:00:01.000Z'),
    );

    await expect(publisher.publishBatch()).resolves.toBe(1);

    expect(broker.published).toEqual(['event-1']);
    expect(message.publishedAt).toEqual(new Date('2026-01-01T00:00:01.000Z'));
    expect(message.isPending()).toBe(false);
  });

  it('schedules retry when the broker rejects a message', async () => {
    // A transient broker failure keeps the event pending and applies backoff.
    const message = createMessage();
    const broker = new FakeBroker();
    broker.shouldFail = true;
    const publisher = new OutboxPublisher(
      new FakeUnitOfWork(new FakeStore([message])),
      broker,
      () => new Date('2026-01-01T00:00:10.000Z'),
    );

    await expect(publisher.publishBatch()).resolves.toBe(0);

    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date('2026-01-01T00:00:11.000Z'));
  });
});
