# Distributed Transaction Processing

A distributed financial service for processing wagering transactions with
monetary precision, durable idempotency, safe concurrency, and asynchronous
SQS processing.

## Key features

- NestJS, strict TypeScript, and Bun.
- PostgreSQL as the source of truth.
- MikroORM with versioned migrations.
- `Money` based on `bigint`, with monetary values serialized as strings.
- Wallets with non-negative balances and pessimistic locking by `walletId`.
- Immutable ledger and reconciliation.
- Idempotency through `Idempotency-Key` and canonical payload hashes.
- Durable Inbox for message deduplication.
- Transactional Outbox with retries and at-least-once publication.
- FIFO SQS queues and DLQ through MiniStack.
- Worker for out-of-order references.
- Health checks, structured logs, and operational metrics.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for architectural decisions, flows,
consistency guarantees, and limitations.

## Requirements

- Bun 1.x
- Docker and Docker Compose
- Git

## Running with Docker Compose

Install dependencies and start PostgreSQL, MiniStack, and the application:

```bash
bun install
docker compose up --build
```

The `.env` file is optional. Compose uses the defaults from
`docker-compose.yml` when it is absent. To customize local settings, copy
`.env.example` to `.env`; keep `.env` local and never commit production
credentials.

Local services:

| Service     | URL                     |
| ----------- | ----------------------- |
| Application | `http://localhost:3000` |
| PostgreSQL  | `localhost:5432`        |
| MiniStack   | `http://localhost:4566` |

Compose automatically enables:

- SQS consumer;
- pending-reference worker;
- Outbox publisher;
- primary queue `wager-transactions.fifo`;
- DLQ `wager-transactions-dlq.fifo`;
- event queue `wager-events.fifo`.

## Running the application locally without Docker

Keep PostgreSQL and MiniStack running, copy the example environment file, and
adjust it for your local setup:

```bash
cp .env.example .env
set -a
. ./.env
set +a

bun run start:dev
```

To run only the API, keep all three workers disabled.

## Main environment variables

| Variable                               | Default                       | Description               |
| -------------------------------------- | ----------------------------- | ------------------------- |
| `DATABASE_URL`                         | Compose                       | PostgreSQL connection URL |
| `PORT`                                 | `3000`                        | HTTP port                 |
| `AWS_ENDPOINT_URL`                     | —                             | MiniStack/AWS endpoint    |
| `SQS_ENDPOINT`                         | —                             | Alternative SQS endpoint  |
| `SQS_CONSUMER_ENABLED`                 | `true`                        | Enables the consumer      |
| `SQS_QUEUE_NAME`                       | `wager-transactions.fifo`     | Input queue               |
| `SQS_DLQ_NAME`                         | `wager-transactions-dlq.fifo` | Dead-letter queue         |
| `SQS_VISIBILITY_TIMEOUT_SECONDS`       | `30`                          | Message visibility        |
| `SQS_MAX_RECEIVE_COUNT`                | `5`                           | Attempts before the DLQ   |
| `OUTBOX_PUBLISHER_ENABLED`             | `true`                        | Enables the publisher     |
| `OUTBOX_PUBLISHER_INTERVAL_MS`         | `1000`                        | Publisher interval        |
| `OUTBOX_QUEUE_NAME`                    | `wager-events.fifo`           | Event queue               |
| `PENDING_REFERENCE_WORKER_ENABLED`     | `true`                        | Enables retries           |
| `PENDING_REFERENCE_WORKER_INTERVAL_MS` | `5000`                        | Worker interval           |
| `PENDING_REFERENCE_MAX_ATTEMPTS`       | `8`                           | Maximum attempts          |

## HTTP API

### Process a transaction

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
X-Correlation-Id: request-123
Content-Type: application/json
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "player-1",
  "walletId": "wallet-1",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}
```

Supported operations: `BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK`.
`REFUND` and `ROLLBACK` require `referenceExternalTransactionId`.

Main responses:

- `201`: transaction processed;
- `202`: transaction waiting for a reference;
- `400`: invalid payload or missing `Idempotency-Key`;
- `404`: wallet or reference not found;
- `409`: same idempotency key with a different payload;
- `422`: business-rule rejection.

### Reconciliation

```bash
curl -X POST http://localhost:3000/wallets/wallet-1/reconciliation
```

This is a read-only operation. It compares the persisted balance with the
balance reconstructed from the ledger and reports divergences without silently
repairing them.

### Health checks and metrics

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
curl http://localhost:3000/health/metrics
```

- `/health/live`: process is running.
- `/health/ready`: PostgreSQL and SQS are available; returns `503` when a
  dependency is unavailable.
- `/health/metrics`: process-local counters for status, replays, retries, DLQ,
  locks, contention, latency, and Outbox activity.

Metrics are process-local and reset when the application restarts.

## Migrations

Check the migration state:

```bash
bunx mikro-orm migration:check
```

Run migrations:

```bash
bunx mikro-orm migration:up
```

Create a migration after changing the schema:

```bash
bunx mikro-orm migration:create
```

## Testing and quality

```bash
# Unit tests
bun test

# E2E tests with real PostgreSQL and MiniStack services
bun run test:e2e

# TypeScript
bunx tsc --noEmit --incremental false

# Lint
bun run lint

# Formatting
bunx prettier --check README.md ARCHITECTURE.md src test

# Build
bun run build
```

The E2E tests cover concurrent idempotency, wallet locks, distinct wallets
processed in parallel, Inbox handling, redelivery, retries, DLQ, concurrent
Outbox publishers, three application instances, crashes between commit and ACK,
and restart with reconciliation.

## Architecture summary

The `ProcessWagerTransaction` use case is shared by HTTP and SQS. Wallet,
transaction, ledger, Inbox, and Outbox changes occur in the same PostgreSQL
transaction. The Outbox publisher marks an event as published only after the
broker confirms it.

The system uses at-least-once delivery. Consumers must therefore be
idempotent: a crash after broker confirmation can result in duplicate
publication.

## Security and production

Authentication is outside the scope of this challenge. In production, the
financial endpoint must be protected by an external IdP and an `AuthGuard`;
there is no local user table or custom password authentication.

Before production:

- replace test credentials;
- configure authentication and authorization;
- export metrics to a durable backend;
- remove fixed Compose names and ports;
- configure observability and alerting;
- validate broker retention and DLQ policies.

## Related documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [Technical challenge](./Technical-challenge.md)
