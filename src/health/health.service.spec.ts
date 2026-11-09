import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('reports liveness without contacting dependencies', () => {
    const service = new HealthService({} as EntityManager, {} as SQSClient);

    expect(service.live()).toEqual({ status: 'ok' });
  });

  it('reports readiness when PostgreSQL and SQS are available', async () => {
    const execute = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    const send = vi.fn().mockResolvedValue({ QueueUrls: [] });
    const service = new HealthService(
      { getConnection: () => ({ execute }) } as unknown as EntityManager,
      { send } as unknown as SQSClient,
    );

    await expect(service.ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up', sqs: 'up' },
    });
    expect(execute).toHaveBeenCalledWith('select 1');
    expect(send).toHaveBeenCalledWith(expect.any(ListQueuesCommand));
  });

  it('reports dependency failures explicitly', async () => {
    const service = new HealthService(
      {
        getConnection: () => ({
          execute: vi.fn().mockRejectedValue(new Error('database offline')),
        }),
      } as unknown as EntityManager,
      {
        send: vi.fn().mockRejectedValue(new Error('sqs offline')),
      } as unknown as SQSClient,
    );

    await expect(service.ready()).resolves.toEqual({
      status: 'error',
      checks: { database: 'down', sqs: 'down' },
      errors: { database: 'database offline', sqs: 'sqs offline' },
    });
  });
});
