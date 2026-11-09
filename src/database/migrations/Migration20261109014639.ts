import { Migration } from '@mikro-orm/migrations';

export class Migration20261109014639 extends Migration {

  override name = 'Migration20261109014639';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" text not null, "provider_id" text not null, "external_transaction_id" text not null, "idempotency_key" text not null, "payload_hash" text not null, "wallet_id" text not null, "player_id" text not null, "round_id" text not null, "game_id" text not null, "kind" text not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" text null, "reference_transaction_id" text null, "status" text not null default 'PENDING', "failure_code" text null, "created_at" timestamptz not null default now(), "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "wager_transactions_wallet_status_idx" on "wager_transactions" ("wallet_id", "status");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_idempotency_unique" unique ("idempotency_key");`);

    this.addSql(`create table "wallets" ("id" text not null, "player_id" text not null, "currency" varchar(3) not null, "balance_amount" numeric(20,2) not null default '0', "version" int not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" text not null, "wallet_id" text not null, "transaction_id" text not null, "direction" text not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "created_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`create index "wallet_ledger_entries_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_wallet_unique" unique ("transaction_id", "wallet_id");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_amount_check" check ("amount" > 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_currency_check" check ("currency" ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_external_transaction_id_check" check ("kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_failure_code_check" check ("status" not in ('REJECTED', 'FAILED') or "failure_code" is not null);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_processed_at_check" check ("status" <> 'PROCESSED' or "processed_at" is not null);`);

    this.addSql(`alter table "wallets" add constraint "wallets_currency_check" check ("currency" ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallets" add constraint "wallets_balance_amount_check" check ("balance_amount" >= 0);`);
    this.addSql(`alter table "wallets" add constraint "wallets_version_check" check ("version" >= 1);`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT'));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_amount_check" check ("amount" > 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_currency_check" check ("currency" ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balance_before_check" check ("balance_before" >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balance_after_check" check ("balance_after" >= 0 and (("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount") or ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}
