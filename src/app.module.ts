import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './mikro-orm.config.js';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction.js';
import { MikroOrmWagerTransactionUnitOfWork } from './infrastructure/persistence/wager-transaction-persistence.js';
import { WageringController } from './application/wagering/wagering.controller.js';
import { WagerTransactionConsumer } from './application/messaging/wager-transaction-consumer.js';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  SqsWagerConsumerWorker,
  SqsWagerQueue,
  SqsWagerTransport,
} from './infrastructure/messaging/sqs-wager-transport.js';
import { SqsWagerLifecycle } from './infrastructure/messaging/sqs-wager-lifecycle.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { PendingReferenceWorker } from './application/wagering/pending-reference-worker.js';
import { WalletReconciliationController } from './application/reconciliation/wallet-reconciliation.controller.js';
import { WalletReconciliationService } from './application/reconciliation/wallet-reconciliation.service.js';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [
    AppController,
    WageringController,
    HealthController,
    WalletReconciliationController,
  ],
  providers: [
    AppService,
    HealthService,
    PendingReferenceWorker,
    WalletReconciliationService,
    MikroOrmWagerTransactionUnitOfWork,
    {
      provide: ProcessWagerTransaction,
      inject: [MikroOrmWagerTransactionUnitOfWork],
      useFactory: (unitOfWork: MikroOrmWagerTransactionUnitOfWork) =>
        new ProcessWagerTransaction(unitOfWork),
    },
    {
      provide: SQSClient,
      useFactory: () =>
        new SQSClient({
          region: process.env.AWS_REGION ?? 'us-east-1',
          endpoint: process.env.AWS_ENDPOINT_URL ?? process.env.SQS_ENDPOINT,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }),
    },
    {
      provide: SqsWagerQueue,
      inject: [SQSClient],
      useFactory: (client: SQSClient) =>
        new SqsWagerQueue(client, {
          queueName: process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo',
          deadLetterQueueName:
            process.env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
          visibilityTimeoutSeconds: Number(
            process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 30,
          ),
          maxReceiveCount: Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5),
          fifo: true,
        }),
    },
    {
      provide: SqsWagerTransport,
      inject: [SQSClient],
      useFactory: (client: SQSClient) =>
        new SqsWagerTransport(
          client,
          '',
          '',
          Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 30),
        ),
    },
    {
      provide: WagerTransactionConsumer,
      inject: [ProcessWagerTransaction, SqsWagerTransport],
      useFactory: (
        processWagerTransaction: ProcessWagerTransaction,
        transport: SqsWagerTransport,
      ) =>
        new WagerTransactionConsumer(
          processWagerTransaction,
          transport,
          process.env.SQS_CONSUMER_NAME ?? 'wager-consumer',
          Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5),
        ),
    },
    {
      provide: SqsWagerConsumerWorker,
      inject: [SqsWagerQueue, SqsWagerTransport, WagerTransactionConsumer],
      useFactory: (
        queue: SqsWagerQueue,
        transport: SqsWagerTransport,
        consumer: WagerTransactionConsumer,
      ) => new SqsWagerConsumerWorker(queue, transport, consumer),
    },
    SqsWagerLifecycle,
  ],
})
export class AppModule {}
