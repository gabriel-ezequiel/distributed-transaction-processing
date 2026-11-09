# Architecture

## Overview

The service processes wagering operations against player wallets. PostgreSQL
is the source of truth for wallet balances, wager transactions, the immutable
ledger, Inbox records, and the Transactional Outbox. MiniStack emulates SQS for
local development and integration tests.

Authentication is intentionally out of scope for this challenge. Health
endpoints remain public and the wagering endpoint is currently an explicit
extension point for an external IdP/AuthGuard in a deployment environment.
No local user table or password authentication is used.

The application is organized into four layers:

- `src/domain`: business rules and immutable value objects.
- `src/application`: use cases, workers, controllers, and transport
  orchestration.
- `src/infrastructure`: MikroORM persistence and SQS adapters.
- `src/health`: liveness and readiness endpoints.

The domain does not depend on NestJS or MikroORM types. Infrastructure adapters
implement application ports and map persisted records to domain objects.

## Financial processing

`ProcessWagerTransaction` is the single financial use case used by HTTP and
SQS. Every execution runs in one PostgreSQL transaction:

1. Validate the command and parse the monetary value as `Money`.
2. Claim the Inbox record when the command came from SQS.
3. Check the durable idempotency key and payload hash.
4. Lock the wallet with `PESSIMISTIC_WRITE`.
5. Apply `BET`, `WIN`, `LOSS`, `REFUND`, or `ROLLBACK`.
6. Persist the wager transaction and wallet.
7. Persist an immutable ledger entry when the balance changes.
8. Persist the integration event in the Outbox.
9. Commit all changes atomically.

The response snapshot is stored with the transaction so an idempotent replay
returns the original result instead of recalculating a potentially different
balance.

`Money` uses `bigint` cents internally and accepts decimal strings with exactly
two fractional digits. Monetary values remain strings at API and event
boundaries. A wallet cannot be debited below zero.

## HTTP flow

`POST /wagering/transactions` requires the `Idempotency-Key` header. The
controller computes a canonical payload hash and passes the command to the
shared use case.

An identical replay returns the persisted result. Reusing the same key with a
different payload produces an idempotency conflict. Business rejection,
pending references, invalid input, and transient failures remain distinct
outcomes.

## SQS flow

The FIFO queue and its DLQ are created by `SqsWagerQueue`. The consumer parses
the event, preserves the current receipt handle, and delegates processing to
the shared use case.

The Inbox uniqueness constraint `(consumerName, messageId)` makes redelivery
safe. The message is acknowledged only after the database transaction commits.
Transient failures change message visibility for retry; permanent failures are
published to the DLQ. A redelivered SQS message can have a different receipt
handle, so acknowledgement always uses the handle from the current delivery.

`SqsWagerLifecycle` starts the consumer only when
`SQS_CONSUMER_ENABLED=true` and stops polling during Nest shutdown. This allows
multiple application instances to consume the same queue safely.

## Transactional Outbox

Financial events are serialized into the Outbox in the same SQL transaction as
the wallet, transaction, and ledger changes. The publisher claims due pending
rows using row locks and `SKIP LOCKED`, allowing multiple publishers to work
concurrently without claiming the same row.

In the local Compose profile, `OutboxPublisherLifecycle` publishes pending
events to the FIFO `wager-events.fifo` queue through MiniStack. It is controlled
by `OUTBOX_PUBLISHER_ENABLED` and `OUTBOX_PUBLISHER_INTERVAL_MS`. Queue
availability is retried in the background so a temporary SQS outage does not
prevent the application from starting; readiness still reports the dependency
as unavailable.

A row is marked published only after the broker confirms publication. Retries
use a persistent attempt counter and backoff. A process crash after broker
confirmation but before the database update can publish an event more than
once; consumers must therefore remain idempotent.

## References outside order

`REFUND` and `ROLLBACK` require a provider transaction reference. If that
reference is not available, the transaction is persisted as
`PENDING_REFERENCE` without applying a financial movement.

`PendingReferenceWorker` retries due records with exponential backoff. After
the configured maximum number of attempts, the transaction is rejected with
`REFERENCE_NOT_FOUND` and the rejection event is written through the Outbox.

## Reconciliation and health

`POST /wallets/:walletId/reconciliation` reads the wallet and all ledger
entries, validates entry-level invariants, and compares the persisted balance
with the balance reconstructed from the opening balance plus net movements.
It is read-only and never repairs financial data silently. Divergences are
reported in the response and logged.

`GET /health/live` verifies that the process is running. `GET /health/ready`
checks PostgreSQL and SQS connectivity and returns `503` while either
dependency is unavailable.

`GET /health/metrics` exposes process-local counters for transaction status,
idempotent replays, consumer retries/DLQ, wallet lock acquisitions, Outbox
publication and lag, lock wait/contention, and processing latency. A lock
contention is counted when acquisition takes at least one millisecond. These
counters reset when the process restarts; production deployments should export
them to a durable metrics backend.

## Persistence invariants

PostgreSQL enforces the identities and invariants that must hold across
instances:

- one wallet per player and currency;
- one provider transaction per external transaction identity;
- durable idempotency keys;
- one Inbox record per consumer and message;
- at most one ledger entry per wallet and transaction;
- valid non-negative monetary values and currencies;
- foreign-key relationships between transactions and ledger entries.

Wallet locks protect concurrent operations for the same wallet. Operations on
different wallets can proceed in parallel.

## Local operations

Start PostgreSQL, MiniStack, and the application with:

```bash
bun install
docker compose up --build
```

The local endpoints are:

- application: `http://localhost:3000`;
- PostgreSQL: `localhost:5432`;
- MiniStack: `http://localhost:4566`.

The SQS consumer and pending-reference worker are enabled by Docker Compose.
For local execution outside Docker, configure `DATABASE_URL`,
`AWS_ENDPOINT_URL`/`SQS_ENDPOINT`, AWS test credentials, and the worker
feature flags as described in [README.md](./README.md).

## Limitations

- The Outbox provides at-least-once delivery, not exactly-once publication.
- MiniStack is an emulator and is not a production AWS availability model.
- The Compose file is intended for local development and currently uses fixed
  container names and host ports.
- Metrics are process-local and reset on restart; they do not yet provide
  cross-instance aggregation or a durable DLQ-depth gauge.
