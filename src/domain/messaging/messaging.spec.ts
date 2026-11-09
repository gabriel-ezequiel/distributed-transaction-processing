import { describe, expect, it } from 'vitest';
import {
  IntegrationEvent,
  IntegrationEventProps,
  InvalidIntegrationEventError,
} from './integration-event.js';
import { InboxMessage, InvalidInboxMessageError } from './inbox-message.js';
import { InvalidOutboxMessageError, OutboxMessage } from './outbox-message.js';

interface TestEventData {
  value: string;
}

class TestEvent extends IntegrationEvent<TestEventData> {
  readonly eventType = 'TestEvent';
  readonly version = 1;

  constructor(props: IntegrationEventProps<TestEventData>) {
    super(props);
  }
}

const eventDate = new Date('2026-01-01T00:00:00.000Z');

function createTestEvent(): TestEvent {
  return new TestEvent({
    eventId: 'event-1',
    aggregateId: 'wallet-1',
    correlationId: 'correlation-1',
    occurredAt: eventDate,
    data: { value: 'sample' },
  });
}

describe('IntegrationEvent', () => {
  describe('serialization', () => {
    it('serializes a typed event with a stable ISO timestamp and version', () => {
      // The outbox stores this envelope rather than a domain object instance.
      expect(createTestEvent().toJSON()).toEqual({
        eventId: 'event-1',
        eventType: 'TestEvent',
        aggregateId: 'wallet-1',
        correlationId: 'correlation-1',
        occurredAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        data: { value: 'sample' },
      });
    });

    it('rejects events without required identifiers', () => {
      // Missing identity would make tracing and deduplication unreliable.
      expect(
        () =>
          new TestEvent({
            eventId: '',
            aggregateId: 'wallet-1',
            correlationId: 'correlation-1',
            occurredAt: eventDate,
            data: { value: 'sample' },
          }),
      ).toThrow(InvalidIntegrationEventError);
    });
  });
});

describe('InboxMessage', () => {
  describe('lifecycle', () => {
    it('receives an unprocessed message and marks it processed once', () => {
      // Processing is marked only after the transaction handling the message succeeds.
      const inbox = InboxMessage.receive({
        messageId: 'message-1',
        consumerName: 'wager-consumer',
        payloadHash: 'hash-1',
        receivedAt: eventDate,
      });

      expect(inbox.isProcessed()).toBe(false);
      inbox.markProcessed(new Date('2026-01-01T00:00:01.000Z'));

      expect(inbox.isProcessed()).toBe(true);
      expect(() => inbox.markProcessed(eventDate)).toThrow(
        InvalidInboxMessageError,
      );
    });

    it('rehydrates a processed message without exposing mutable dates', () => {
      // Persistence reconstruction must preserve state without sharing Date references.
      const receivedAt = new Date(eventDate);
      const inbox = InboxMessage.rehydrate({
        messageId: 'message-1',
        consumerName: 'wager-consumer',
        payloadHash: 'hash-1',
        receivedAt,
        processedAt: new Date('2026-01-01T00:00:01.000Z'),
      });

      receivedAt.setUTCFullYear(2030);
      expect(inbox.receivedAt.getUTCFullYear()).toBe(2026);
      expect(inbox.isProcessed()).toBe(true);
    });
  });
});

describe('OutboxMessage', () => {
  describe('publication lifecycle', () => {
    it('enqueues a typed event as a pending message', () => {
      // The event type and payload are copied into the persistence boundary.
      const outbox = OutboxMessage.enqueue(createTestEvent());

      expect(outbox.id).toBe('event-1');
      expect(outbox.eventType).toBe('TestEvent');
      expect(outbox.attempts).toBe(0);
      expect(outbox.isPending()).toBe(true);
      expect(outbox.isDue(eventDate)).toBe(true);
    });

    it('schedules exponential retry delays', () => {
      // Retry timing is deterministic so workers can coordinate consistently.
      const outbox = OutboxMessage.enqueue(createTestEvent());
      const retryAt = new Date('2026-01-01T00:00:10.000Z');

      outbox.scheduleRetry(retryAt);
      expect(outbox.attempts).toBe(1);
      expect(outbox.nextAttemptAt).toEqual(
        new Date('2026-01-01T00:00:11.000Z'),
      );
      expect(outbox.isDue(retryAt)).toBe(false);
      expect(outbox.isDue(new Date('2026-01-01T00:00:11.000Z'))).toBe(true);

      outbox.scheduleRetry(retryAt);
      expect(outbox.attempts).toBe(2);
      expect(outbox.nextAttemptAt).toEqual(
        new Date('2026-01-01T00:00:12.000Z'),
      );
    });

    it('marks a pending message published and prevents later retries', () => {
      // Publication is acknowledged only after the broker confirms delivery.
      const outbox = OutboxMessage.enqueue(createTestEvent());
      const publishedAt = new Date('2026-01-01T00:00:02.000Z');

      outbox.markPublished(publishedAt);

      expect(outbox.isPending()).toBe(false);
      expect(outbox.publishedAt).toEqual(publishedAt);
      expect(outbox.isDue(publishedAt)).toBe(false);
      expect(() => outbox.scheduleRetry(publishedAt)).toThrow(
        InvalidOutboxMessageError,
      );
    });

    it('rehydrates retry state and rejects invalid attempt counts', () => {
      // Workers restart from persisted retry state instead of resetting attempts.
      const outbox = OutboxMessage.rehydrate({
        id: 'event-1',
        aggregateId: 'wallet-1',
        eventType: 'TestEvent',
        payload: { value: 'sample' },
        occurredAt: eventDate,
        attempts: 2,
        nextAttemptAt: new Date('2026-01-01T00:00:12.000Z'),
      });

      expect(outbox.attempts).toBe(2);
      expect(() =>
        OutboxMessage.rehydrate({
          id: 'event-2',
          aggregateId: 'wallet-1',
          eventType: 'TestEvent',
          payload: {},
          occurredAt: eventDate,
          attempts: -1,
        }),
      ).toThrow(InvalidOutboxMessageError);
    });
  });
});
