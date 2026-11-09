import { EntityManager } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { WalletEntity } from '../src/infrastructure/persistence/entities/wallet.entity.js';

describe('Multiple application instances integration', () => {
  const walletId = `e2e-multi-wallet-${randomUUID()}`;
  let apps: INestApplication[] = [];
  let entityManager: EntityManager;

  beforeAll(async () => {
    apps = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const module = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();
        const app = module.createNestApplication();
        await app.init();
        return app;
      }),
    );
    entityManager = apps[0]!.get(EntityManager).fork();
    entityManager.create(WalletEntity, {
      id: walletId,
      playerId: 'e2e-multi-player',
      currency: 'BRL',
      balanceAmount: '100.00',
      version: 1,
    });
    await entityManager.flush();
  });

  afterAll(async () => {
    await entityManager
      .getConnection()
      .execute('delete from "wallet_ledger_entries" where "wallet_id" = ?', [
        walletId,
      ]);
    await entityManager
      .getConnection()
      .execute('delete from "wager_transactions" where "wallet_id" = ?', [
        walletId,
      ]);
    await entityManager
      .getConnection()
      .execute('delete from "wallets" where "id" = ?', [walletId]);
    await Promise.all(apps.map((app) => app.close()));
  });

  it('processes requests across three application instances', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        request(apps[index % apps.length]!.getHttpServer())
          .post('/wagering/transactions')
          .set('Idempotency-Key', `e2e-multi-${randomUUID()}`)
          .send({
            providerId: 'e2e-multi-provider',
            externalTransactionId: `e2e-multi-external-${randomUUID()}`,
            playerId: 'e2e-multi-player',
            walletId,
            roundId: `e2e-multi-round-${index}`,
            gameId: 'e2e-game',
            kind: 'BET',
            money: { amount: '3.00', currency: 'BRL' },
          }),
      ),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    entityManager.clear();
    const wallet = await entityManager.findOneOrFail(WalletEntity, {
      id: walletId,
    });
    expect(wallet.balanceAmount).toBe('70.00');
    expect(wallet.version).toBe(11);
  });

  it('restarts an instance and preserves the reconciled balance', async () => {
    const stopped = apps.pop();
    await stopped?.close();
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const restarted = module.createNestApplication();
    await restarted.init();
    apps.push(restarted);

    const response = await request(restarted.getHttpServer())
      .post(`/wallets/${walletId}/reconciliation`)
      .expect(201);
    expect(response.body).toMatchObject({
      walletId,
      consistent: true,
      entriesChecked: 10,
      difference: { amount: '0.00', currency: 'BRL' },
    });
  });
});
