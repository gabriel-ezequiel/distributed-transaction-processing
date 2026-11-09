import { Injectable } from '@nestjs/common';
import { WagerTransactionStatus } from '../domain/wager-transaction/wager-transaction.js';

export interface ApplicationMetricsSnapshot {
  transactions: {
    processed: number;
    rejected: number;
    pendingReference: number;
    idempotentReplays: number;
    latencyMs: { count: number; total: number };
  };
  messaging: {
    retries: number;
    deadLetters: number;
    acknowledgements: number;
  };
  persistence: {
    walletLockAcquisitions: number;
    outboxPublished: number;
    outboxRetries: number;
    outboxLagMs: { count: number; total: number };
  };
}

@Injectable()
export class ApplicationMetrics {
  private readonly counters = {
    processed: 0,
    rejected: 0,
    pendingReference: 0,
    idempotentReplays: 0,
    retries: 0,
    deadLetters: 0,
    acknowledgements: 0,
    walletLockAcquisitions: 0,
    outboxPublished: 0,
    outboxRetries: 0,
  };

  private transactionLatency = { count: 0, total: 0 };
  private outboxLag = { count: 0, total: 0 };

  recordTransaction(
    status: WagerTransactionStatus,
    idempotentReplay: boolean,
    latencyMs: number,
  ): void {
    if (status === WagerTransactionStatus.Processed) {
      this.counters.processed += 1;
    } else if (status === WagerTransactionStatus.Rejected) {
      this.counters.rejected += 1;
    } else if (status === WagerTransactionStatus.PendingReference) {
      this.counters.pendingReference += 1;
    }
    if (idempotentReplay) this.counters.idempotentReplays += 1;
    this.transactionLatency.count += 1;
    this.transactionLatency.total += Math.max(0, latencyMs);
  }

  recordAcknowledgement(): void {
    this.counters.acknowledgements += 1;
  }

  recordRetry(): void {
    this.counters.retries += 1;
  }

  recordDeadLetter(): void {
    this.counters.deadLetters += 1;
  }

  recordWalletLockAcquisition(): void {
    this.counters.walletLockAcquisitions += 1;
  }

  recordOutboxPublished(lagMs: number): void {
    this.counters.outboxPublished += 1;
    this.outboxLag.count += 1;
    this.outboxLag.total += Math.max(0, lagMs);
  }

  recordOutboxRetry(): void {
    this.counters.outboxRetries += 1;
  }

  snapshot(): ApplicationMetricsSnapshot {
    return {
      transactions: {
        processed: this.counters.processed,
        rejected: this.counters.rejected,
        pendingReference: this.counters.pendingReference,
        idempotentReplays: this.counters.idempotentReplays,
        latencyMs: { ...this.transactionLatency },
      },
      messaging: {
        retries: this.counters.retries,
        deadLetters: this.counters.deadLetters,
        acknowledgements: this.counters.acknowledgements,
      },
      persistence: {
        walletLockAcquisitions: this.counters.walletLockAcquisitions,
        outboxPublished: this.counters.outboxPublished,
        outboxRetries: this.counters.outboxRetries,
        outboxLagMs: { ...this.outboxLag },
      },
    };
  }
}
