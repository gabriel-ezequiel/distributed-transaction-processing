import { Migration } from '@mikro-orm/migrations';

export class Migration20261109041042 extends Migration {

  override name = 'Migration20261109041042';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "reference_attempts" int not null default 0, add "next_reference_attempt_at" timestamptz null;`);
    this.addSql(`create index "wager_transactions_reference_retry_idx" on "wager_transactions" ("status", "next_reference_attempt_at");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_attempts_check" check ("reference_attempts" >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_reference_retry_idx";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_attempts_check";`);
    this.addSql(`alter table "wager_transactions" drop column "reference_attempts", drop column "next_reference_attempt_at";`);
  }

}
