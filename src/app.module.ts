import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './mikro-orm.config.js';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction.js';
import { MikroOrmWagerTransactionUnitOfWork } from './infrastructure/persistence/wager-transaction-persistence.js';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [AppController],
  providers: [
    AppService,
    MikroOrmWagerTransactionUnitOfWork,
    {
      provide: ProcessWagerTransaction,
      inject: [MikroOrmWagerTransactionUnitOfWork],
      useFactory: (unitOfWork: MikroOrmWagerTransactionUnitOfWork) =>
        new ProcessWagerTransaction(unitOfWork),
    },
  ],
})
export class AppModule {}
