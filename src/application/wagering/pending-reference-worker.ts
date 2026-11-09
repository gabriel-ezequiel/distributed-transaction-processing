import { Injectable } from '@nestjs/common';
import { MikroOrmWagerTransactionUnitOfWork } from '../../infrastructure/persistence/wager-transaction-persistence.js';
import {
  ProcessWagerTransaction,
} from './process-wager-transaction.js';

@Injectable()
export class PendingReferenceWorker {
  constructor(
    private readonly unitOfWork: MikroOrmWagerTransactionUnitOfWork,
    private readonly processWagerTransaction: ProcessWagerTransaction,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const ids = await this.unitOfWork.transactional((store) =>
      store.findDuePendingReferenceIds(50, now),
    );
    let processed = 0;
    for (const id of ids) {
      const result = await this.processWagerTransaction.retryPendingReference(
        id,
        Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 8),
        now,
      );
      if (result) {
        processed += 1;
      }
    }
    return processed;
  }
}
