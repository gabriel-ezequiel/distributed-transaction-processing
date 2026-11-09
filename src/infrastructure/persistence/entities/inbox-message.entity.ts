import { defineEntity, p } from '@mikro-orm/core';

/**
 * MikroORM persistence model for a message received by a consumer.
 *
 * Inbox rows make message handling durable and idempotent. The composite
 * uniqueness constraint prevents the same consumer from processing a message
 * more than once while allowing different consumers to receive it.
 */
export const InboxMessageEntity = defineEntity({
  name: 'InboxMessage',
  tableName: 'inbox_messages',
  properties: {
    /** Stable identifier for the persisted inbox record. */
    id: p.text().primary(),
    /** Message identifier supplied by the transport. */
    messageId: p.text().fieldName('message_id'),
    /** Logical consumer that owns the deduplication boundary. */
    consumerName: p.text().fieldName('consumer_name'),
    /** Hash of the received payload used to detect conflicting redeliveries. */
    payloadHash: p.text().fieldName('payload_hash'),
    /** Time at which the message was first received. */
    receivedAt: p.datetime().fieldName('received_at').defaultRaw('now()'),
    /** Time at which the consumer completed processing, if successful. */
    processedAt: p.datetime().fieldName('processed_at').nullable(),
  },
  uniques: [
    {
      /** Prevents duplicate processing by the same consumer. */
      name: 'inbox_messages_consumer_message_unique',
      properties: ['consumerName', 'messageId'],
    },
  ],
  indexes: [
    {
      /** Supports queries for unprocessed messages. */
      name: 'inbox_messages_consumer_processed_idx',
      properties: ['consumerName', 'processedAt'],
    },
  ],
});
