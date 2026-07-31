# Audit & Business Observability Platform
## RabbitMQ + Worker Architecture Document

**Status:** Design for a **future, unimplemented** module — see notice below
**Audience:** Engineering
**Companion to:** Platform Design Overview, Database Design (TimescaleDB), SDK Architecture

> **Status notice (this revision):** this document describes the design of the
> optional queue transport + Worker + database persistence pipeline. **None of
> it is implemented as of this revision.** The SDK (`@tnet06/mapa-audit-sdk`)
> is implemented and usable today with zero infrastructure via its console and
> file transports — see `sdk-architecture.md`. This document, along with
> `database-design.md`, should be read as forward-looking design for a future,
> separate, opt-in module (`@tnet06/mapa-audit-transport-queue` on the SDK
> side, plus a standalone Worker service — see `platform-general-overview.md`
> §4), not as current platform behavior. The topology, idempotency strategy,
> and retry design below remain the intended approach when this module is
> built.

---

### 1. Purpose

This document describes the transport and processing layer of the platform: how events travel from the SDK to durable storage. It covers the RabbitMQ topology (exchanges, queues, bindings), the Worker's consumption and persistence logic, idempotency enforcement, the retry policy, and the Dead Letter Queue (DLQ).

This is the layer where the platform's two central promises are actually enforced:

- **No duplicate rows**, even though delivery is at-least-once.
- **No silently lost messages** on the *processing* side — anything the Worker can't handle ends up in the DLQ, never dropped.

(Note the boundary: **as of this revision, the SDK has no queue transport and
no in-memory buffering of any kind** — that earlier claim was inaccurate and
has been removed. When the queue transport is built, its buffering/backpressure
behavior on the SDK side, if any, will be specified in the queue transport's
own design, not assumed here. From the moment a message is durably in
RabbitMQ onward, this document's guarantees apply — that boundary is still
correct in principle, there is simply no SDK-side buffer preceding it today.)

---

### 2. Design Goals

- **Decoupling:** the consuming service's request flow is never affected by Worker or database health.
- **At-least-once processing with idempotent effect:** redeliveries are safe because inserts deduplicate on `(occurred_at, id)`.
- **Isolation of poison messages:** one malformed event must never block the queue or crash the Worker loop.
- **Backpressure:** the Worker pulls at a controlled rate rather than being overwhelmed by bursts.
- **Observability of the pipeline itself:** the Worker exposes metrics (processed, failed, retried, DLQ'd) so the platform can watch its own health.

---

### 3. RabbitMQ Topology

```
                       (routing key = event_type)
  SDK ──publish──▶ ┌──────────────────────────┐
                   │  audit.events (exchange)  │   type: topic
                   └────────────┬─────────────┘
                                │ binding: "#"  (all event types)
                                ▼
                     ┌────────────────────────┐
                     │  audit.events.q (queue) │
                     │  x-dead-letter-exchange:│
                     │     audit.retry.dlx     │
                     └───────────┬────────────┘
                                 │ consume (prefetch=N)
                                 ▼
                          ┌─────────────┐
                          │   Worker    │
                          └─────────────┘

  Retry / DLQ path:
                     ┌────────────────────────┐
                     │  audit.retry.dlx (dlx)  │  type: direct
                     └───────────┬────────────┘
                        ┌────────┴─────────┐
                        ▼                  ▼
              ┌──────────────────┐  ┌──────────────────┐
              │ audit.retry.q     │  │ audit.dead.q      │
              │ (TTL + requeue)   │  │ (terminal)        │
              └────────┬─────────┘  └────────┬─────────┘
                       │ after TTL            │ Worker persists to
                       ▼                      ▼  dead_letter_events table
             back to audit.events        (operational review)
```

#### 3.1 Exchange: `audit.events` (topic)

- **Type:** `topic`. The routing key is the event's `event_type` (`business`, `error`, `security`, etc.).
- **Mapping note:** the SDK's canonical `AuditEvent` field is `eventType`
  (camelCase, as with all `AuditEvent` fields — see `sdk-architecture.md` §4).
  The queue/DB layer's convention is snake_case (`event_type`, matching the DB
  column naming in `database-design.md`). The queue transport, when built, is
  responsible for this translation when publishing — routing key and any
  serialized message fields use snake_case; the SDK's in-process event object
  never does. This applies to field names generally at this boundary, not only
  `event_type`.
- **Why topic and not direct/fanout:** a topic exchange costs nothing today (a single queue binds with `#` to receive everything) but leaves the door open, without redesign, to add future consumers that subscribe to only certain event types — e.g. a real-time security-alerting consumer binding to `security.*`, or a metrics consumer. This is the routing flexibility that motivated choosing RabbitMQ over a simpler job queue.

#### 3.2 Main Queue: `audit.events.q`

- **Durable:** survives broker restarts.
- **Bound** to `audit.events` with routing key `#` (all events).
- Declared with `x-dead-letter-exchange = audit.retry.dlx`, so rejected/failed messages are routed into the retry/DLQ path rather than lost.

#### 3.3 Retry & Dead-Letter path

- **`audit.retry.dlx` (direct exchange):** receives dead-lettered messages and routes them either to the retry queue (transient failures) or the terminal dead queue (permanent failures), based on retry count.
- **`audit.retry.q`:** a holding queue with a message TTL (e.g. 30s). When the TTL expires, messages dead-letter *back* to `audit.events` for another processing attempt. This implements **delayed retry without blocking the main queue** — the classic RabbitMQ TTL-requeue pattern.
- **`audit.dead.q`:** terminal queue for messages that exhausted their retries or are structurally invalid. The Worker drains this into the `dead_letter_events` table for human/operational review.

---

### 4. Worker Responsibilities

The Worker is a standalone service (its own process/container, never embedded in a consuming app, and never published as an npm package — see `platform-general-overview.md` §4). Its loop:

1. **Consume** a message from `audit.events.q` (respecting prefetch).
2. **Validate** the message shape (see §5).
3. **Persist** it idempotently to TimescaleDB (see §6).
4. **Ack** on success; **route to retry/DLQ** on failure (see §7).

The Worker is intentionally the *only* component that writes to the database. Consuming services never touch Postgres directly — this keeps the storage contract in one place and lets the schema evolve without coordinating with every consumer.

The Worker described here is a **reference implementation**. A team adopting the queue transport is not required to run this exact Worker — the real contract is the shape of the message on the queue (the shared `AuditEvent` type, translated per §3.1), not a code dependency on this specific service. Teams with different persistence needs can write their own consumer against the same queue.

---

### 5. Message Validation

Before any DB work, the Worker validates each message against the expected `AuditEvent` shape (a schema check — e.g. Zod/JSON-schema). This produces a clean fork:

- **Structurally valid** → proceed to persistence.
- **Structurally invalid** (missing required field, wrong types, unparseable JSON) → this is a *permanent* failure. Retrying won't fix a malformed message, so it goes **straight to the terminal DLQ**, not the retry loop. Distinguishing permanent from transient failure here is what stops a poison message from cycling through retries forever.

---

### 6. Persistence & Idempotency

The Worker persists using the client-generated `id` and the `ON CONFLICT` guarantee established in the SDK and DB designs:

```sql
INSERT INTO audit_events (
  id, correlation_id, causation_id, ..., occurred_at
) VALUES ($1, $2, $3, ..., $N)
ON CONFLICT (occurred_at, id) DO NOTHING;
```

Because delivery is at-least-once, a redelivered message carries the *same* `id`; the `ON CONFLICT (occurred_at, id) DO NOTHING` makes the second insert a no-op. **Idempotency is achieved at the database level, not by tracking "seen" IDs in Worker memory** — which matters because the Worker may be horizontally scaled (multiple instances consuming the same queue), and in-memory dedup wouldn't be shared across them. The DB is the single source of truth for "have I seen this event."

#### 6.1 Batched inserts (throughput)

For high volume, the Worker accumulates valid events in a small in-memory batch and flushes them in a single multi-row insert (e.g. every 100 events or every 500ms, whichever comes first). Notes:

- The batch insert still uses `ON CONFLICT DO NOTHING`, so idempotency holds per-row.
- **Ack only after the batch is durably committed.** Messages in an unflushed batch are left un-acked, so a Worker crash mid-batch causes RabbitMQ to redeliver them — and idempotency makes that redelivery safe. This is the mechanism that gives at-least-once processing without duplicates.
- Batching is a throughput optimization, not a correctness requirement; a single-insert Worker is valid for lower volumes and simpler to reason about.

---

### 7. Retry Policy

Failures are classified, and the classification decides the path:

| Failure type | Example | Action |
|---|---|---|
| **Permanent** | Malformed message, failed schema validation, CHECK-constraint violation | Straight to terminal DLQ — retrying cannot help |
| **Transient** | DB temporarily unreachable, connection pool exhausted, deadlock | Retry with backoff via `audit.retry.q` |

**Mechanics of a transient retry:**

1. Worker rejects the message (`nack`, `requeue=false`) so it dead-letters to `audit.retry.dlx`.
2. It lands in `audit.retry.q`, where it waits out the TTL (delay).
3. On TTL expiry it dead-letters back to `audit.events` for another attempt.
4. A retry counter is carried in the message headers (`x-retry-count`). After a max (e.g. 5), the message is routed to the terminal `audit.dead.q` instead of retried again.

This gives **exponential-ish delayed retry** (by using tiered retry queues with increasing TTLs, or a single TTL for simplicity) without ever blocking the main queue — failing messages step aside and let healthy traffic flow.

---

### 8. Dead Letter Handling

Messages in `audit.dead.q` are consumed by the Worker (or a dedicated small drainer) and written to the `dead_letter_events` table:

```sql
INSERT INTO dead_letter_events (
  id, original_event_id, source_queue, payload, error_message, retry_count, failed_at
) VALUES ($1, $2, $3, $4, $5, $6, now());
```

This table is the operational surface for failures: engineers query it to see *what* failed, *why* (`error_message`), and *how many times* it was retried. From here, a fixed message can be manually re-published, or a systemic problem (e.g. a bad deploy producing malformed events) can be diagnosed. Nothing that enters the pipeline is ever silently lost on the processing side — it's either persisted to `audit_events` or captured in `dead_letter_events`.

---

### 9. Backpressure & Concurrency

- **Prefetch (`prefetch=N`):** the Worker fetches at most N unacked messages at a time (e.g. 50), preventing a burst from overwhelming it or exhausting the DB connection pool. This is the same backpressure pattern used elsewhere in this codebase.
- **Horizontal scaling:** multiple Worker instances can consume the same `audit.events.q` competing-consumer style. Idempotency (DB-level) and the stateless Worker design make this safe with no coordination.
- **Connection management:** a single long-lived connection with a channel per concurrency unit, via `amqp-connection-manager` for automatic reconnection.

---

### 10. Failure Modes Summary

| Scenario | Behavior |
|---|---|
| Message redelivered (at-least-once) | Deduplicated at insert via `ON CONFLICT` — no duplicate row |
| Malformed / invalid message | Straight to terminal DLQ; never retried, never blocks queue |
| DB transiently down | Message retried with delay via retry queue; recovers when DB returns |
| DB down beyond max retries | Message lands in `dead_letter_events` for manual replay |
| Worker crashes mid-batch | Un-acked messages redelivered by RabbitMQ; idempotency makes reprocessing safe |
| Burst of traffic | Prefetch limits in-flight work; queue absorbs the burst; Workers drain at safe rate |
| Multiple Workers running | Safe — competing consumers + DB-level idempotency, no shared state needed |

---

### 11. Pipeline Observability

The Worker exposes metrics (Prometheus-style, consistent with the platform's Grafana stack) so the pipeline can watch itself:

- `events_processed_total`, `events_failed_total`, `events_retried_total`, `events_dead_lettered_total`
- Insert latency and batch-flush duration
- Current queue depth (via RabbitMQ management metrics) — the key early-warning signal that the Worker is falling behind ingestion

A growing `audit.events.q` depth is the single most important alert: it means events are arriving faster than they're being persisted, or the Worker/DB is unhealthy.

---

### 12. Out of Scope for v1

- Tiered exponential-backoff retry queues (v1 may use a single fixed retry TTL for simplicity).
- Additional event-type-specific consumers (the topic exchange leaves room; none built yet).
- Automatic replay tooling from `dead_letter_events` (v1 is manual re-publish).
- Cross-region broker replication.

Documented as conscious boundaries, each a candidate for a future scoped iteration.