# Audit & Business Observability Platform
## Platform Design Overview

**Status:** Draft for review
**Audience:** Product & Engineering
**Owner:** Platform Engineering

---

## 1. What This Is

The Audit & Business Observability Platform is an internal, reusable system that lets any backend service record what happened inside it — business actions, errors, security events, and request traces — without each team having to build its own logging pipeline.

Teams integrate by installing a single SDK. Everything downstream (transport, processing, storage, dashboards) is operated centrally as a shared service. The goal is that onboarding a new service takes minutes, not days, and that the whole organization gets consistent, queryable audit and observability data out of the box.

In one sentence: **it turns "every team reinvents logging" into "install one SDK and you're done."**

---

## 2. Why It Exists

Today, each service tends to solve this problem in isolation — one team writes logs to a local table, another to files, another to a third-party tool. The result is fragmented: no consistent format, no cross-service correlation, and audit trails that live in whatever shape each team happened to choose.

This platform exists to provide:

- **Consistency** — one event format across every service.
- **Correlation** — follow a single request across multiple services via a shared correlation ID.
- **Self-service** — teams consume it without operating any infrastructure themselves.
- **Separation of concerns** — audit/observability logging never blocks or slows down the business request it's recording.

---

## 3. Scope & Positioning (read this before anything else)

This platform deliberately sits at the intersection of two related-but-distinct disciplines, and it's important the whole team shares the same understanding of which guarantees we do and don't provide:

| | **Observability** (what we guarantee) | **Legal-grade Audit** (what we do NOT guarantee in v1) |
|---|---|---|
| Purpose | Debugging, tracing, operational insight | Compliance, non-repudiation, legal evidence |
| Durability | Best-effort — events may be dropped if the platform is unavailable and local buffers fill | Guaranteed — no event may ever be lost |
| Failure stance | Never impact the host application, even at the cost of an event | Never lose an event, even at the cost of blocking |

**v1 is an observability-first platform with strong audit ergonomics, not a legal-grade audit system.** The name includes "Audit" because it captures audit-style events (who did what, when, to which entity) with excellent traceability — but its durability guarantees are best-effort by design (see §6). If the organization later needs legal-grade guarantees for specific event types, that becomes a scoped follow-up with a different durability path, not a silent assumption.

This distinction is called out up front because the word "audit" implies stronger guarantees than a best-effort pipeline provides, and product decisions should be made with that clarity.

---

## 4. High-Level Architecture

```
┌────────────────────────────────────────────────────┐
│  Consuming Service (Express / Fastify / NestJS ...) │
│                                                       │
│   business logic  ──▶  record(event)  ◀── SDK        │
│                              │                        │
│   request enters ──▶ adapter captures context        │
│      (correlation id, user, ip, endpoint, ...)       │
└──────────────────────────────┬───────────────────────┘
                               │ publish (fire-and-forget)
                               ▼
                        ┌─────────────┐
                        │  RabbitMQ    │  central, shared
                        └──────┬───────┘
                               │
                        ┌──────▼───────┐
                        │   Worker      │  idempotent, DLQ-backed
                        │  (consumer)   │
                        └──────┬───────┘
                               │  ON CONFLICT DO NOTHING
                        ┌──────▼───────┐
                        │  PostgreSQL   │  single partitioned table
                        │  audit_events │
                        └──────┬───────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
              ┌──────────┐         ┌─────────────┐
              │ Grafana  │         │ Internal API │
              │dashboards│         │ (read-only)  │
              └──────────┘         └─────────────┘
```

The system is a classic asynchronous ingestion pipeline: capture cheaply and locally, hand off to a queue, process out-of-band, store in a query-optimized shape, expose for reading.

---

## 5. The Four Components

### 5.1 The SDK (what teams install)

The only piece consuming teams touch. Its entire public contract is two functions:

- `initAuditSDK(config)` — called once at startup.
- `record(event)` — called anywhere in business logic.

Everything else is automatic:

- **Context capture** — a per-framework adapter (Express, Fastify, NestJS, Next.js) reads the incoming request and stores request context (correlation ID, user, IP, endpoint, etc.) in Node's `AsyncLocalStorage`. Business code calls `record()` without ever passing the request object around.
- **Framework-agnostic core** — the capture-and-publish engine knows nothing about any framework. Adding a new framework means writing one small adapter file; the core never changes.
- **Fire-and-forget** — `record()` never blocks business logic and never throws into it. If the queue is down, events are buffered in memory and the host app continues normally. **Protecting the host application always wins over capturing an event.**

### 5.2 RabbitMQ (transport)

A central, shared message broker that decouples event capture from event storage. This decoupling is the core value: if the Worker or database is slow, restarting, or down, the consuming services are unaffected — events queue up and drain when the pipeline recovers.

### 5.3 The Worker (processing & persistence)

A standalone service (its own process, never embedded in a consuming app) that:

- Consumes events from the queue.
- Deduplicates them idempotently (see §6).
- Persists them to PostgreSQL.
- Routes un-processable messages to a Dead Letter Queue for diagnosis and retry, so a single bad message never blocks the pipeline or gets lost silently.

### 5.4 Storage & Read Layer

- **PostgreSQL** — a single partitioned `audit_events` table using an `event_type` discriminator plus a flexible `JSONB payload`. Chosen over multiple specialized tables for simpler ingestion, no joins to reconstruct a request, and easy addition of new event types.
- **Grafana** — connects directly to PostgreSQL (no Prometheus required) for dashboards and ad-hoc queries.
- **Internal API** — a read-only HTTP interface for teams that need programmatic access to their audit data without direct database access.

---

## 6. Key Design Decisions

These are the decisions that define the platform's correctness and behavior. They should be treated as fixed contracts unless deliberately revisited.

### 6.1 Idempotency via client-generated event IDs

RabbitMQ guarantees *at-least-once* delivery, meaning the same event can legitimately arrive more than once (consumer restarts, network blips, redeliveries). To prevent duplicate rows:

- The **SDK generates each event's `id`** before publishing — not the database at insert time.
- The Worker inserts with `ON CONFLICT DO NOTHING`, so a redelivered event is silently discarded.

This is a platform-wide contract: `id` generation location is a correctness guarantee, not an implementation detail.

### 6.2 Best-effort durability (the deliberate trade-off)

When the queue is unreachable, the SDK buffers events in memory (capped) and drops the oldest if the buffer fills. This is intentional and follows directly from §3: **for an observability platform, never harming the host application is worth more than guaranteeing every single event.** Teams needing stronger guarantees for specific event types should treat that as a scoped extension, not an assumption about current behavior.

### 6.3 `occurred_at` vs `created_at`

Two timestamps are stored: when the event *happened* in the application (`occurred_at`, set by the SDK) and when it was *persisted* (`created_at`, set on insert). Because ingestion is asynchronous, these can diverge during backlog — keeping both is what lets us tell real event timing apart from pipeline delay. The table is partitioned by `occurred_at` because queries ask about business time, not ingestion time.

### 6.4 `route_pattern` alongside raw endpoint

Both the concrete URL (`/users/123/orders/456`) and its pattern (`/users/:userId/orders/:orderId`) are stored. Aggregating dashboards by the pattern avoids the cardinality explosion that makes grouping by raw URL useless.

### 6.5 Strong constraints on classification fields

`event_type`, `severity`, and `environment` are constrained to fixed allowed values at the database level. A typo from one service (`'prod'` vs `'production'`) can't silently pollute the dataset and break everyone's dashboards.

---

## 7. Sensitive Data & Retention (must be addressed, not deferred)

The platform captures personal data — `ip_address`, `user_id`, `user_agent`. This carries real obligations that product and engineering must plan around, even if full tooling isn't built in v1:

- **This data is PII.** It is subject to data-protection regulations (GDPR-style) wherever the organization operates.
- **Retention is not only a performance concern.** Time-based partitioning makes dropping old data efficient, and that doubles as a coarse retention policy — but it does not, on its own, satisfy per-user deletion ("right to be forgotten") requests.
- **v1 minimum stance:** document what PII is captured, set a default retention window enforced by partition dropping, and flag per-user erasure and field-level anonymization as known, scoped follow-ups rather than surprises discovered later.

Raising this at design time — rather than after an auditor or a user request forces it — is a core part of treating this as a real platform.

### Recommended v1 addition

Add a `payload_schema_version` column now. It's trivial to add today and impossible to reconstruct retroactively; it's what keeps JSONB flexibility from becoming an ungovernable swamp as event shapes evolve across services.

---

## 8. Operational Model

- **Local development / small deployments:** `docker compose up` brings up the Worker, RabbitMQ, PostgreSQL, and Grafana together in one command. Consuming a service is then just `npm install` of the SDK plus pointing it at the queue URL.
- **Production:** infrastructure (managed PostgreSQL, managed or self-hosted RabbitMQ, the Worker) is provisioned via Terraform. The Worker never knows or cares whether its dependencies are local containers or managed cloud services — it only receives connection strings via environment variables (12-factor).
- **Partition management:** automated from day one (via `pg_partman` or a scheduled job that pre-creates the next period's partition). Without this, inserts outside existing ranges fail — it is not optional.

---

## 9. Build Order (recommended)

1. Extract the existing logging worker into a standalone Worker service.
2. Add idempotency (`ON CONFLICT`) and Dead Letter Queue handling.
3. Build the SDK core plus one framework adapter, end-to-end.
4. Containerize everything (`docker compose`).
5. Add Terraform for a cloud deployment.
6. Build the read layer (Grafana dashboards first, then the internal API).

Each step produces something demonstrable, avoiding a long stretch with nothing runnable.

---

## 10. Explicitly Out of Scope for v1

- Legal-grade / guaranteed-durability audit path
- Per-user data erasure and field-level PII anonymization tooling
- Automatic correlation-ID propagation on outbound HTTP calls
- Event batching/compression
- Disk-backed (crash-durable) SDK buffer
- Browser/frontend SDK

These are documented not as omissions but as conscious boundaries, each a candidate for a future scoped iteration.

---

## 11. Component Reference Documents

This overview is the entry point. Detailed design lives in companion documents:

- **Database Design** — table schema, partitioning, indexes, idempotency mechanics.
- **SDK Architecture** — public API, AsyncLocalStorage, adapters, failure modes, versioning.
- **RabbitMQ + Worker Architecture** — exchanges, queues, retries, DLQ, consumer logic *(next)*.
- **API Design** — read endpoints for querying events and audits *(planned)*.
- **Grafana & Observability** — dashboards and standard queries *(planned)*.
- **Deployment Architecture** — Docker Compose and Terraform layouts *(planned)*.