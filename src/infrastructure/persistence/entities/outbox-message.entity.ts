import { defineEntity, p } from '@mikro-orm/core';

/**
 * MikroORM persistence model for a transactional integration event.
 *
 * Outbox rows are written in the same SQL transaction as the financial state.
 * A separate publisher can safely retry unpublished rows until they are
 * marked as published.
 */
export const OutboxMessageEntity = defineEntity({
  name: 'OutboxMessage',
  tableName: 'outbox_messages',
  properties: {
    /** Stable event identifier used by publishers and downstream consumers. */
    id: p.text().primary(),
    /** Aggregate identifier that produced the integration event. */
    aggregateId: p.text().fieldName('aggregate_id'),
    /** Stable event name used by subscribers to route the payload. */
    eventType: p.text().fieldName('event_type'),
    /** Serialized integration event envelope stored as PostgreSQL JSONB. */
    payload: p
      .json<Readonly<Record<string, unknown>>>()
      .fieldName('payload')
      .columnType('jsonb'),
    /** Time at which the domain event occurred. */
    occurredAt: p.datetime().fieldName('occurred_at').defaultRaw('now()'),
    /** Number of publish attempts made for this event. */
    attempts: p.integer().default(0).check('"attempts" >= 0'),
    /** Earliest time at which the next publish attempt is allowed. */
    nextAttemptAt: p.datetime().fieldName('next_attempt_at').nullable(),
    /** Time at which the event was successfully published, if any. */
    publishedAt: p.datetime().fieldName('published_at').nullable(),
  },
  indexes: [
    {
      /** Supports concurrent publishers selecting due, unpublished events. */
      name: 'outbox_messages_pending_idx',
      properties: ['publishedAt', 'nextAttemptAt'],
    },
    {
      /** Supports event history and aggregate-based diagnostics. */
      name: 'outbox_messages_aggregate_occurred_idx',
      properties: ['aggregateId', 'occurredAt'],
    },
  ],
});
