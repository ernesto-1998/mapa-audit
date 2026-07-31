# Audit & Business Observability Platform
## Database Design Document (TimescaleDB)

**Status:** Design for a **future, unimplemented** module — see notice below

> **Status notice (this revision):** this document describes the persistence
> layer of the optional queue transport + Worker pipeline. **None of it is
> implemented as of this revision.** The SDK (`@tnet06/mapa-audit-sdk`) is
> implemented and usable today with zero infrastructure via its console and
> file transports — see `sdk-architecture.md`. This document should be read
> as forward-looking design for a future, separate, opt-in module — see
> `platform-general-overview.md` §4. Three reconciliation notes relative to
> the current SDK's `AuditEvent` shape are called out inline below, and
> repeated in `docs/BUILD_PLAN.md` Phase 10, to be resolved before this schema
> is implemented.

### Purpose

This document describes the database design for the Audit & Business Observability Platform. The persistence layer is built on **TimescaleDB** (a PostgreSQL extension for time-series data), because an audit/observability event stream is, by nature, time-series data: append-only, timestamp-ordered, rarely updated, and queried by time range.

The design prioritizes:

- Simple ingestion (one insert per event)
- Efficient querying from Grafana and internal APIs
- Correlation of complete request flows
- **Investigability** — fixed columns answer "what happened, to what, by whom, with what outcome, on which instance" without opening the JSONB
- **High-volume scalability** via automatic time-based chunking
- Support for asynchronous processing (RabbitMQ)
- **Guaranteed idempotency**, tied to client-side `id` generation
- Future compatibility with distributed tracing (OpenTelemetry)

---

### Why TimescaleDB (and what a hypertable is)

The `audit_events` table is a **hypertable**: to application code it looks and behaves exactly like a normal Postgres table (same SQL, same drivers, same Grafana datasource), but internally TimescaleDB automatically splits it into many small time-ordered partitions called **chunks** (e.g. one per week).

This replaces the manual `PARTITION BY RANGE` + `pg_partman` + cron-job setup that plain Postgres would require. Benefits for this workload:

- **Write speed stays constant as history grows** — new events always land in the current (small) chunk, not a giant monolithic table.
- **Time-range queries are fast** — TimescaleDB only scans the chunks covering the queried window (chunk exclusion), ignoring the rest.
- **Retention is instantaneous** — dropping old data means dropping whole chunks, not row-by-row `DELETE` that locks a large table.
- **Native compression** of older chunks (often 90%+ size reduction) for cheap long-term storage.
- **Continuous aggregates** — self-updating materialized views, ideal for Grafana dashboards over large volumes.

**Durability scope (important):** TimescaleDB is PostgreSQL underneath and inherits its full durability guarantees (WAL, ACID) — once an event is inserted, it is safely persisted. However, guaranteeing that *no event is ever lost end-to-end* is a property of the whole pipeline (SDK → queue transport → Worker → DB), **not** of the database. As of this revision, the SDK has no queue transport and no in-memory buffering of any kind — that behavior, if any, will be specified in the future queue transport's own design (see `rabbitmq-worker-architecture.md` §1). The hypertable guarantees that what arrives is stored durably and scales; it does not, and cannot, prevent loss upstream of itself.

---

### Why a Single `audit_events` Hypertable?

Instead of multiple 1:1 specialized tables (`error_events`, `business_events`, etc.), the platform uses a single `audit_events` hypertable with an `event_type` discriminator and a JSONB `payload`.

Advantages: one insert per event, simpler idempotency, no joins to reconstruct a request, easy addition of new event types, and — with TimescaleDB — automatic time-based chunking and retention out of the box.

---

### Main Table

> **Reconciliation notes (read before implementing):** three columns below
> need adjustment against the current SDK `AuditEvent` shape
> (`sdk-architecture.md` §4). They are marked inline with ⚠ and summarized
> after the table.

```sql
-- Requires: CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE audit_events (
    -- IMPORTANT: id is generated client-side by the SDK, before publishing
    -- to the queue. This is what makes idempotent inserts possible on
    -- redelivery. See "Idempotency Design" below.
    id              UUID NOT NULL,

    -- Correlation & causality
    correlation_id  UUID,             -- ⚠ nullable — see note 1 below
    causation_id    UUID,             -- the event that directly caused this one
    request_id      UUID,             -- ⚠ see note 2 below (not in AuditEvent today)
    trace_id        TEXT,             -- reserved for OpenTelemetry (not in AuditEvent today)
    span_id         TEXT,             -- reserved for OpenTelemetry (not in AuditEvent today)

    -- Origin
    service_name    TEXT NOT NULL,
    service_version TEXT,            -- correlate incidents with deploys
    instance_id     TEXT,            -- specific replica/pod/container
    server_name     TEXT,            -- ⚠ see note 2 below (not in AuditEvent today)
    environment     TEXT NOT NULL,

    -- Classification (event_type = domain, severity = gravity, outcome = result)
    event_type      TEXT NOT NULL,
    event_name      TEXT NOT NULL,
    severity        TEXT NOT NULL,
    outcome         TEXT,

    -- Actor (who caused it — human OR machine)
    actor_type      TEXT,            -- 'user' | 'service' | 'system' | 'job'
    user_id         TEXT,            -- acts as actor_id; NULL for anonymous/non-user
    user_role       TEXT,
    tenant_id       TEXT,

    -- HTTP Context (populated whenever request context was captured — see note 3)
    http_method     TEXT,
    endpoint        TEXT,
    route_pattern   TEXT,
    status_code     INT,             -- ⚠ see note 2 below (not in AuditEvent today)
    duration_ms     INT,             -- ⚠ see note 2 below (not in AuditEvent today)
    ip_address      INET,
    user_agent      TEXT,

    -- Business Entity affected
    entity_type     TEXT,
    entity_id       TEXT,

    -- Schema governance for the variable payload
    payload_schema_version  INT NOT NULL DEFAULT 1,

    -- Variable, event-specific data
    payload         JSONB NOT NULL DEFAULT '{}',

    -- Timestamps
    occurred_at     TIMESTAMPTZ NOT NULL,   -- when it happened (set by SDK)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when persisted (DB-side; not an AuditEvent field)

    -- The partitioning column (occurred_at) must be part of any unique/primary key.
    PRIMARY KEY (occurred_at, id),

    CONSTRAINT chk_audit_events_event_type
      CHECK (event_type IN ('request','business','audit','error','security','system')),
    CONSTRAINT chk_audit_events_severity
      CHECK (severity IN ('debug','info','warn','error','critical')),
    CONSTRAINT chk_audit_events_environment
      CHECK (environment IN ('development','staging','production')),
    CONSTRAINT chk_audit_events_outcome
      CHECK (outcome IN ('success','failure','partial')),
    CONSTRAINT chk_audit_events_actor_type
      CHECK (actor_type IN ('user','service','system','job'))
);

-- Convert the table into a hypertable, chunked by occurred_at (1-week chunks).
SELECT create_hypertable(
    'audit_events',
    'occurred_at',
    chunk_time_interval => INTERVAL '7 days'
);
```

The `PRIMARY KEY (occurred_at, id)` requirement is the same as with native partitioning: TimescaleDB requires the partitioning column (`occurred_at`) to be part of any unique or primary key. This also makes the idempotent `ON CONFLICT (occurred_at, id)` insert work cleanly.

**Reconciliation notes:**

1. **`correlation_id` must be nullable, not `NOT NULL`.** In the current SDK,
   `AuditEvent.correlationId` is optional — an event recorded outside any
   request context (e.g. a background job using `createAudit()` directly, with
   no adapter populating context) legitimately has no correlation ID. A
   `NOT NULL` constraint here would reject valid events the SDK can produce
   today. Loosen this constraint, or have the Worker generate a fallback ID
   for events that arrive without one (if a non-null value is preferred for
   query ergonomics) — a decision to make explicitly before Phase 10, not a
   given.
2. **Several columns have no corresponding field in the current `AuditEvent`**:
   `request_id`, `trace_id`, `span_id`, `server_name`, `status_code`,
   `duration_ms`. These were anticipated for future SDK capability
   (OpenTelemetry integration, HTTP response timing) that does not exist yet.
   They are not wrong to keep as forward-looking columns, but the Worker
   cannot populate them from what the SDK sends today — they will be `NULL`
   for every row until the SDK grows fields to fill them, or they map from
   something the queue transport/Worker derives independently (e.g.
   `duration_ms` would need to be measured by an adapter around the request,
   which the SDK does not do today). `created_at` is not part of this list —
   it is correctly DB-side only (set by the Worker on insert), never an
   `AuditEvent` field, and needs no reconciliation.
3. **HTTP context is not scoped to `event_type='request'` in the current SDK.**
   The Express adapter attaches `request` context (method, endpoint, IP, user
   agent) to *any* event recorded during a request — `business`, `security`,
   `system`, whatever `eventType` the caller chooses — not only to a
   dedicated `'request'` event type. In practice, most events captured during
   an HTTP request will have these columns populated regardless of
   `event_type`. The "populated only for `event_type='request'`" framing in
   earlier drafts does not match this — treat these columns as "populated
   whenever request context was available when the event was recorded," not
   as type-gated.

---

### Retention & Compression Policies (TimescaleDB-native)

These replace the manual partition-dropping logic plain Postgres would need:

```sql
-- Automatically drop chunks older than 12 months (adjust to compliance needs).
SELECT add_retention_policy('audit_events', INTERVAL '12 months');

-- Automatically compress chunks older than 30 days to save storage.
ALTER TABLE audit_events SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'service_name, event_type',
    timescaledb.compress_orderby   = 'occurred_at DESC'
);
SELECT add_compression_policy('audit_events', INTERVAL '30 days');
```

> **Retention is not only a performance setting — it's also a data-protection lever.** Because the table stores PII (`ip_address`, `user_id`, `user_agent`), the retention window is partly a legal decision. Note that chunk-based retention handles time-based expiry but does **not** satisfy per-user erasure ("right to be forgotten"), which remains a scoped follow-up.

---

### Idempotency Design

The queue guarantees *at-least-once* delivery, so the same event can arrive more than once (consumer restarts, redeliveries). The SDK generates each event's `id` before publishing; the Worker inserts idempotently:

```sql
INSERT INTO audit_events (id, correlation_id, ..., occurred_at)
VALUES ($1, $2, ..., $N)
ON CONFLICT (occurred_at, id) DO NOTHING;
```

Where `id` is generated is a fixed platform-wide contract — a correctness guarantee, not an implementation detail. (This already holds true today: `id` is generated client-side by `buildAuditEvent()` in the SDK, independent of whether the queue/Worker/DB module exists — see `sdk-architecture.md` §4.)

---

### Classification Rules (mandatory — read before using `event_type` / `severity`)

`event_type` and `severity` both include `error`. Without an explicit rule, services classify inconsistently and investigation queries become unreliable. The rule:

- **`event_type` = the *domain*** — what kind of thing happened (`request`, `business`, `security`, `system`, `audit`).
- **`severity` = the *gravity*** — how bad it is (`debug` → `critical`).
- **`outcome` = the *result*** — succeeded, failed, or partial; independent of domain, gravity, and HTTP status.

| Situation | event_type | severity | outcome |
|---|---|---|---|
| Recipe updated successfully | `business` | `info` | `success` |
| Business rule rejected the update | `business` | `warn` | `failure` |
| Failed login attempt | `security` | `warn` | `failure` |
| Unhandled exception, no clear domain | `error` | `error`/`critical` | `failure` |
| Scheduled job completed | `system` | `info` | `success` |

`event_type = 'error'` is **reserved** for unhandled exceptions with no clear domain. A failed business operation is `business` + `severity=error` + `outcome=failure` — never `event_type='error'`.

> **Note on `audit` as a type:** `audit` overlaps with `business` (arguably every business event is an audit record — the whole table is `audit_events`). Recommended resolution: reserve `audit` strictly for events that exist *only* for compliance and don't fit business/security (e.g. `pii.accessed`, `data.exported`, `consent.granted`), OR drop it entirely and mark compliance relevance with an orthogonal flag. Pick one and document it so classification doesn't drift.

---

### Column Design

**Correlation & causality** — `correlation_id` groups a whole flow when present (see reconciliation note 1 — it is optional, not guaranteed); `causation_id` links an event to the one that directly caused it (walk the causal chain); `request_id` identifies a single request; `trace_id`/`span_id` reserved for OpenTelemetry (see reconciliation note 2 — none of these three exist in the SDK's event shape today).

**Origin** — `service_name` + `service_version` answer "did this start after the last deploy?"; `instance_id` isolates a single misbehaving replica; `server_name` is the hostname (rotates in containers; see reconciliation note 2 — not populated by the SDK today); `environment` is constrained.

**Classification** — `event_type`, `event_name`, `severity`, `outcome` per the rules above. `event_name` examples: `recipe.created`, `auth.failed_login`, `http.request.completed`.

**Actor** — `actor_type` (`user`/`service`/`system`/`job`) ensures machine-originated events aren't left with an unexplained NULL user; `user_id` doubles as the generic actor id; `user_role`/`tenant_id` give authz and tenancy context.

**HTTP Context** — regular columns because queried frequently; populated whenever request context was available when the event was recorded (see reconciliation note 3 — not gated to `event_type='request'`). `route_pattern` (`/users/:userId/orders/:orderId`) groups dynamic URLs so dashboards aggregate meaningfully instead of exploding per unique ID. `status_code`/`duration_ms` are not populated by the SDK today (reconciliation note 2).

**Entity** — `entity_type`/`entity_id` enable "full history of recipe 123":

```sql
SELECT * FROM audit_events
WHERE entity_type = 'recipe' AND entity_id = '123'
ORDER BY occurred_at DESC;
```

**Payload & governance** — `payload` (JSONB) holds event-specific detail (stack traces, changed fields) so new types need no migrations; `payload_schema_version` lets consumers branch on payload shape as it evolves. Note: the SDK's `AuditEvent.payloadSchemaVersion` exists on the type but is not currently set by `record()`/`RecordInput` — the Worker should not assume every incoming message populates it, and the `DEFAULT 1` here is the practical fallback until the SDK exposes a way to set it explicitly.

```json
// error payload
{ "errorName": "ValidationError", "errorMessage": "Invalid payload", "stackTrace": "..." }
// business payload
{ "before": {}, "after": {}, "changedFields": ["name", "email"] }
```

---

### Time Columns

- `occurred_at`: when the event happened (set by SDK) — the hypertable's chunking column.
- `created_at`: when it was persisted (set by the Worker/DB on insert; not part of `AuditEvent`).

Asynchronous ingestion means these diverge during backlog; keeping both separates real timing from pipeline delay. Chunking by `occurred_at` is correct because queries ask about business time.

---

### Recommended Indexes

```sql
CREATE INDEX idx_audit_events_correlation
  ON audit_events (correlation_id, occurred_at ASC);

CREATE INDEX idx_audit_events_type_time
  ON audit_events (event_type, occurred_at DESC);

CREATE INDEX idx_audit_events_entity_time
  ON audit_events (entity_type, entity_id, occurred_at DESC);

CREATE INDEX idx_audit_events_service_time
  ON audit_events (service_name, occurred_at DESC);

-- Add these guided by observed slow queries, not upfront:
CREATE INDEX idx_audit_events_name_time
  ON audit_events (event_name, occurred_at DESC);
CREATE INDEX idx_audit_events_user_time
  ON audit_events (user_id, occurred_at DESC);
CREATE INDEX idx_audit_events_payload_gin
  ON audit_events USING GIN (payload);
```

> **Write-cost note:** this is a write-heavy table. TimescaleDB indexes are created per-chunk, which keeps them smaller, but each index still adds insert overhead — the GIN index on `payload` especially. Start with the correlation/type/entity/service indexes and add the rest guided by real slow queries. (TimescaleDB's automatic time-based chunk exclusion already makes most time-bounded queries fast without a dedicated `occurred_at` index.)

---

### Nullable Columns

Intentionally sparse by design: HTTP fields apply whenever request context was captured (see reconciliation note 3); `actor_type`/`user_id` are NULL for anonymous or pre-auth events; `correlation_id` is NULL for events recorded outside any request context (reconciliation note 1). Expected, not a defect — document it in onboarding.

---

### Dead Letter Queue Table

```sql
-- A plain table (not a hypertable) — low volume, not time-series.
CREATE TABLE dead_letter_events (
    id                 UUID PRIMARY KEY,
    original_event_id  UUID,
    source_queue       TEXT NOT NULL,
    payload            JSONB NOT NULL,
    error_message      TEXT,
    retry_count        INT NOT NULL DEFAULT 0,
    failed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Stores events that failed processing, for retries and diagnostics. Independent from `audit_events` — it represents processing failures, not persisted events, so it needs neither chunking nor idempotency rules.

---

### Future Improvements

- OpenTelemetry integration (via reserved `trace_id`/`span_id`)
- Continuous aggregates for common Grafana dashboards
- Per-user erasure tooling for PII
- Full schema-version catalog per `event_name`
- Multi-tenant storage optimizations

---

### Summary

Built on TimescaleDB, this design treats the audit/observability stream as what it is — time-series data — and gets automatic chunking, retention, and compression instead of hand-rolled partition management. A single `audit_events` hypertable, backed by strong constraints, client-generated idempotent identity, explicit classification rules, an investigation-ready metadata set (outcome/actor/causality/instance), schema-versioned JSONB, and native retention/compression policies, provides a scalable, production-ready foundation for a reusable platform engineering solution — while being explicit that end-to-end no-loss durability is a pipeline concern, not a database one.

Three reconciliation gaps against the current SDK (see notes above) should be
resolved as part of Phase 10 implementation, not before — this document
remains valid forward-looking design in the meantime.