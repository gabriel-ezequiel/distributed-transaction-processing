import { Migration } from '@mikro-orm/migrations';

export class Migration20261109024506 extends Migration {

  override name = 'Migration20261109024506';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "result_balance_amount" numeric(20,2) null, add "result_balance_currency" varchar(3) null, add "result_wallet_version" int null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_result_wallet_version_check" check ("result_wallet_version" is null or "result_wallet_version" >= 1);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_result_wallet_version_check";`);
    this.addSql(`alter table "wager_transactions" drop column "result_balance_amount", drop column "result_balance_currency", drop column "result_wallet_version";`);
  }

}
