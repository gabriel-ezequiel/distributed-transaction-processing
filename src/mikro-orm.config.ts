import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

export default defineConfig({
  clientUrl: databaseUrl,

  entities: ['./dist/infrastructure/persistence/entities/**/*.entity.js'],
  entitiesTs: ['./src/infrastructure/persistence/entities/**/*.entity.ts'],

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
