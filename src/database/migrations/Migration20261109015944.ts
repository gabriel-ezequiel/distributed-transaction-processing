import { Migration } from '@mikro-orm/migrations';

export class Migration20261109015944 extends Migration {

  override name = 'Migration20261109015944';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("id" text not null, "message_id" text not null, "consumer_name" text not null, "payload_hash" text not null, "received_at" timestamptz not null default now(), "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "inbox_messages_consumer_processed_idx" on "inbox_messages" ("consumer_name", "processed_at");`);
    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_consumer_message_unique" unique ("consumer_name", "message_id");`);

    this.addSql(`create table "outbox_messages" ("id" text not null, "aggregate_id" text not null, "event_type" text not null, "payload" jsonb not null, "occurred_at" timestamptz not null default now(), "attempts" int not null default 0, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "outbox_messages_pending_idx" on "outbox_messages" ("published_at", "next_attempt_at");`);
    this.addSql(`create index "outbox_messages_aggregate_occurred_idx" on "outbox_messages" ("aggregate_id", "occurred_at");`);

    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_attempts_check" check ("attempts" >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
  }

}
