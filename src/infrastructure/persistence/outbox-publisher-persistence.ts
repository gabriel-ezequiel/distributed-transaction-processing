import { InferEntity, LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import {
  OutboxPublisherStore,
  OutboxPublisherUnitOfWork,
} from '../../application/messaging/outbox-publisher.js';
import { OutboxMessageEntity } from './entities/outbox-message.entity.js';

type OutboxRow = InferEntity<typeof OutboxMessageEntity>;

/** MikroORM unit of work for concurrent outbox publishers. */
export class MikroOrmOutboxPublisherUnitOfWork implements OutboxPublisherUnitOfWork {
  constructor(private readonly entityManager: EntityManager) {}

  /** Uses one SQL transaction so row locks cover broker confirmation and state updates. */
  transactional<T>(
    work: (store: OutboxPublisherStore) => Promise<T>,
  ): Promise<T> {
    return this.entityManager.transactional(
      (em) => work(new MikroOrmOutboxPublisherStore(em)),
      { clear: true },
    );
  }
}

/** Transaction-scoped store that locks due outbox rows with SKIP LOCKED. */
export class MikroOrmOutboxPublisherStore implements OutboxPublisherStore {
  private readonly rows = new Map<string, OutboxRow>();

  constructor(private readonly entityManager: EntityManager) {}

  async findDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const claimed = await this.entityManager.execute<{ id: string }[]>(
      `select "id"
       from "outbox_messages"
       where "published_at" is null
         and ("next_attempt_at" is null or "next_attempt_at" <= ?)
       order by "occurred_at" asc
       limit ?
       for update skip locked`,
      [now, limit],
    );
    if (claimed.length === 0) {
      return [];
    }

    const rows = await this.entityManager.find(
      OutboxMessageEntity,
      { id: { $in: claimed.map(({ id }) => id) } },
      {
        lockMode: LockMode.PESSIMISTIC_WRITE,
        fields: [
          'id',
          'aggregateId',
          'eventType',
          'payload',
          'occurredAt',
          'attempts',
          'nextAttemptAt',
          'publishedAt',
        ],
        limit,
        orderBy: { occurredAt: 'asc' },
      },
    );
    for (const row of rows) {
      this.rows.set(row.id, row);
    }
    return rows.map(mapOutboxToDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    const row = this.rows.get(message.id);
    if (!row) {
      throw new Error(`Outbox row was not locked before saving: ${message.id}`);
    }
    row.attempts = message.attempts;
    row.nextAttemptAt = message.nextAttemptAt ?? null;
    row.publishedAt = message.publishedAt ?? null;
    this.entityManager.persist(row);
  }
}

function mapOutboxToDomain(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
  });
}
