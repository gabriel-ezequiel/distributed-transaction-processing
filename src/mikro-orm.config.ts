import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { InboxMessageEntity } from './infrastructure/persistence/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from './infrastructure/persistence/entities/outbox-message.entity.js';
import { WalletLedgerEntryEntity } from './infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from './infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletEntity } from './infrastructure/persistence/entities/wallet.entity.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

export default defineConfig({
  clientUrl: databaseUrl,

  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  debug: process.env.NODE_ENV !== 'production',

  extensions: [Migrator],

  migrations: {
    path: './dist/database/migrations',
    pathTs: './src/database/migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
    emit: 'ts',
  },
});
