import { OnModuleDestroy, OnModuleInit, Injectable } from '@nestjs/common';
import { SqsWagerConsumerWorker } from './sqs-wager-transport.js';

/**
 * Starts the SQS worker only when explicitly enabled and stops it on shutdown.
 */
@Injectable()
export class SqsWagerLifecycle implements OnModuleInit, OnModuleDestroy {
  private running?: Promise<void>;

  constructor(private readonly worker: SqsWagerConsumerWorker) {}

  /** Starts polling after Nest has initialized all dependencies. */
  onModuleInit(): void {
    if (process.env.SQS_CONSUMER_ENABLED !== 'true') {
      return;
    }
    this.running = this.worker.run().catch((error: unknown) => {
      process.stderr.write(
        `SQS consumer stopped unexpectedly: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    });
  }

  /** Requests graceful stop and waits for the current polling cycle. */
  async onModuleDestroy(): Promise<void> {
    this.worker.stop();
    await this.running;
  }
}
