import { PendingReferenceWorker } from './pending-reference-worker.js';
import type { MikroOrmWagerTransactionUnitOfWork } from '../../infrastructure/persistence/wager-transaction-persistence.js';
import type {
  ProcessWagerTransaction,
  ProcessWagerTransactionResult,
  WagerTransactionStore,
} from './process-wager-transaction.js';

describe('PendingReferenceWorker', () => {
  it('retries due transactions and skips transactions with no result', async () => {
    const transactional = vi.fn(
      async (
        work: (store: WagerTransactionStore) => Promise<string[]>,
      ) =>
        work({
          findDuePendingReferenceIds: vi
            .fn()
            .mockResolvedValue(['pending-1', 'pending-2']),
        } as unknown as WagerTransactionStore),
    );
    const retryPendingReference = vi
      .fn()
      .mockResolvedValueOnce({
        transactionId: 'pending-1',
      } as ProcessWagerTransactionResult)
      .mockResolvedValueOnce(undefined);
    const worker = new PendingReferenceWorker(
      { transactional } as unknown as MikroOrmWagerTransactionUnitOfWork,
      { retryPendingReference } as unknown as ProcessWagerTransaction,
    );

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(retryPendingReference).toHaveBeenCalledTimes(2);
    expect(retryPendingReference).toHaveBeenNthCalledWith(
      1,
      'pending-1',
      8,
      expect.any(Date),
    );
  });
});
