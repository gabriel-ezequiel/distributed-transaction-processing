import { OnModuleDestroy, OnModuleInit, Injectable } from '@nestjs/common';
import { SqsWagerConsumerWorker } from './sqs-wager-transport.js';
import { PendingReferenceWorker } from '../../application/wagering/pending-reference-worker.js';

/**
 * Starts the SQS worker only when explicitly enabled and stops it on shutdown.
 */
@Injectable()
export class SqsWagerLifecycle implements OnModuleInit, OnModuleDestroy {
  private running?: Promise<void>;
  private retryTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly worker: SqsWagerConsumerWorker,
    private readonly pendingReferenceWorker: PendingReferenceWorker,
  ) {}

  /** Starts polling after Nest has initialized all dependencies. */
  onModuleInit(): void {
    if (process.env.SQS_CONSUMER_ENABLED === 'true') {
      this.running = this.worker.run().catch((error: unknown) => {
        process.stderr.write(
          `SQS consumer stopped unexpectedly: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED === 'true') {
      const interval = Number(
        process.env.PENDING_REFERENCE_WORKER_INTERVAL_MS ?? 5000,
      );
      this.retryTimer = setInterval(() => {
        void this.pendingReferenceWorker.runOnce().catch((error: unknown) => {
          process.stderr.write(
            `Pending reference worker failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        });
      }, interval);
    }
  }

  /** Requests graceful stop and waits for the current polling cycle. */
  async onModuleDestroy(): Promise<void> {
    this.worker.stop();
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
    }
    await this.running;
  }
}
