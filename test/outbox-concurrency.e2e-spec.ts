import { EntityManager } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  OutboxPublisher,
  IntegrationEventPublisher,
} from '../src/application/messaging/outbox-publisher.js';
import { OutboxMessageEntity } from '../src/infrastructure/persistence/entities/outbox-message.entity.js';
import { MikroOrmOutboxPublisherUnitOfWork } from '../src/infrastructure/persistence/outbox-publisher-persistence.js';

describe('Outbox concurrency integration', () => {
  let app: TestingModule;
  let entityManager: EntityManager;
  const ids: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module;
    await app.init();
    entityManager = app.get(EntityManager).fork();
  });

  afterAll(async () => {
    if (ids.length > 0) {
      await entityManager
        .getConnection()
        .execute('delete from "outbox_messages" where "id" in (?)', [ids]);
    }
    await app.close();
  });

  it('claims one outbox row only once across two publishers', async () => {
    await entityManager
      .getConnection()
      .execute(
        'update "outbox_messages" set "published_at" = now() where "published_at" is null',
      );
    const id = randomUUID();
    ids.push(id);
    entityManager.create(OutboxMessageEntity, {
      id,
      aggregateId: 'wallet-e2e',
      eventType: 'WalletBalanceChanged',
      payload: { eventId: id },
      occurredAt: new Date(),
      attempts: 0,
      nextAttemptAt: null,
      publishedAt: null,
    });
    await entityManager.flush();

    const published: string[] = [];
    const broker: IntegrationEventPublisher = {
      publish: async (message) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        published.push(message.id);
      },
    };
    const first = new OutboxPublisher(
      new MikroOrmOutboxPublisherUnitOfWork(entityManager.fork()),
      broker,
    );
    const second = new OutboxPublisher(
      new MikroOrmOutboxPublisherUnitOfWork(entityManager.fork()),
      broker,
    );

    await expect(
      Promise.all([first.publishBatch(), second.publishBatch()]),
    ).resolves.toEqual([1, 0]);
    expect(published).toEqual([id]);

    entityManager.clear();
    const row = await entityManager.findOneOrFail(OutboxMessageEntity, { id });
    expect(row.publishedAt).toBeInstanceOf(Date);
  });
});
