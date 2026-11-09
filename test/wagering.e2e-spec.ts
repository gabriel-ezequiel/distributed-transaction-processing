import { randomUUID } from 'node:crypto';
import { EntityManager } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { WagerTransactionEntity } from '../src/infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../src/infrastructure/persistence/entities/wallet.entity.js';

describe('Wagering HTTP integration', () => {
  let app: INestApplication;
  let entityManager: EntityManager;
  const walletId = `e2e-wallet-${randomUUID()}`;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    entityManager = app.get(EntityManager).fork();
    entityManager.create(WalletEntity, {
      id: walletId,
      playerId: 'e2e-player',
      currency: 'BRL',
      balanceAmount: '100.00',
      version: 1,
    });
    await entityManager.flush();
  });

  afterAll(async () => {
    if (!entityManager) {
      return;
    }
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
    await app.close();
  });

  it('creates one financial effect for concurrent identical replays', async () => {
    const payload = {
      providerId: 'e2e-provider',
      externalTransactionId: `e2e-external-${randomUUID()}`,
      playerId: 'e2e-player',
      walletId,
      roundId: 'e2e-round',
      gameId: 'e2e-game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const idempotencyKey = `e2e-key-${randomUUID()}`;

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('Idempotency-Key', idempotencyKey)
          .send(payload),
      ),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(
      responses.filter((response) => response.body.idempotentReplay === false),
    ).toHaveLength(1);

    const entries = await entityManager.find(WalletLedgerEntryEntity, {
      wallet: walletId,
    });
    const transactions = await entityManager.find(WagerTransactionEntity, {
      wallet: walletId,
    });
    expect(entries).toHaveLength(1);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.status).toBe('PROCESSED');
  });

  it('serializes distinct concurrent bets without losing balance updates', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        request(app.getHttpServer())
          .post('/wagering/transactions')
          .set('Idempotency-Key', `e2e-concurrent-${randomUUID()}`)
          .send({
            providerId: 'e2e-provider',
            externalTransactionId: `e2e-distinct-${randomUUID()}`,
            playerId: 'e2e-player',
            walletId,
            roundId: `e2e-round-${index}`,
            gameId: 'e2e-game',
            kind: 'BET',
            money: { amount: '5.00', currency: 'BRL' },
          }),
      ),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    entityManager.clear();
    const wallet = await entityManager.findOneOrFail(WalletEntity, {
      id: walletId,
    });
    expect(wallet.balanceAmount).toBe('65.00');
    expect(wallet.version).toBe(7);
  });
});
