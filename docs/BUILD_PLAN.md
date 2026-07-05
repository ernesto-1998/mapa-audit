# BUILD_PLAN.md

Ordered build plan for the Audit & Business Observability Platform.

This is the **shared map of what gets built and in what order**. It is not a
detailed spec — each phase points to the design document that specifies it. The
architect assigns phases (or sub-steps) to the coding agent one at a time; the
agent implements the referenced phase, notes assumptions, and leaves the work for
review (never commits — see `AGENTS.md` §0.1).

**How to use this file:**
- Work top to bottom. Each phase depends on the ones before it.
- Do only the phase you're assigned. Do not jump ahead or combine phases.
- Before implementing, read the linked design doc section.
- Each phase should end in something reviewable and, where applicable, tested.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done & reviewed

---

## Phase 0 — Repository Scaffolding
**Doc:** SDK Architecture §2 · Database Design (for shared types)

- [ ] Monorepo structure under `packages/` (workspaces configured for the repo's
      package manager).
- [ ] Shared TypeScript config (strict mode) inherited by all packages.
- [ ] Shared types module — the **single source of truth** for the event
      contract: `AuditEvent` interface, and the `event_type`, `severity`,
      `outcome`, `actor_type` enums/unions. Imported by every other package
      (see `AGENTS.md` §3).
- [ ] Base lint/format config.
- [ ] No business logic yet.

**Done when:** the workspace builds, the shared types compile, and other packages
can import from the types module.

---

## Phase 1 — SDK Core: Storage
**Doc:** SDK Architecture §4.1

- [ ] `AsyncLocalStorage` instance and the `RequestContext` interface.
- [ ] Helpers to get/run the current context.
- [ ] Unit tests: context is isolated per async execution, retrievable deep in the
      call stack, and absent-context is handled gracefully.

**Done when:** context can be set for a run and read from nested async calls.

---

## Phase 2 — SDK Core: Producer
**Doc:** SDK Architecture §4.2 · RabbitMQ + Worker §3 (exchange/routing)

- [ ] RabbitMQ connection/channel via `amqp-connection-manager` (auto-reconnect).
- [ ] `publish(event)` to the `audit.events` topic exchange, routing key =
      `event_type`.
- [ ] Capped in-memory buffer for when the broker is unreachable (best-effort,
      per the durability contract) — never throws into the caller.
- [ ] Unit tests: publish path, buffer-on-failure path, buffer overflow drops
      oldest with a warning.

**Done when:** events publish when the broker is up and are safely buffered (not
thrown) when it's down.

---

## Phase 3 — SDK Core: record()
**Doc:** SDK Architecture §4.3 · Database Design (classification rules)

- [ ] `record(input)` builds a full `AuditEvent`: **generates `id` client-side**,
      merges `AsyncLocalStorage` context with explicit input, sets `occurred_at`,
      applies default severity.
- [ ] Fire-and-forget: synchronous to the caller, never awaited, never throws.
- [ ] Respects the classification contract (`event_type` / `severity` /
      `outcome` as separate concerns).
- [ ] Unit tests: id is present and client-generated; context merge is correct;
      calling outside a request context still works.

**Done when:** a `record()` call produces a well-formed event and hands it to the
producer without blocking or throwing.

---

## Phase 4 — SDK Core: Config / init
**Doc:** SDK Architecture §4.4

- [ ] `initAuditSDK(config)` with validation (including `environment` against the
      same allowed values the DB enforces — fail fast at startup).
- [ ] Wire config into producer and record.
- [ ] Unit tests: invalid config rejected at init; valid config initializes.

**Done when:** the SDK is initialized explicitly and invalid config fails loudly
at startup.

---

## Phase 5 — SDK: First Framework Adapter
**Doc:** SDK Architecture §5

- [ ] Implement **one** adapter first (the primary framework in use). Build the
      `RequestContext` from the request and run the rest inside
      `auditContext.run(...)`.
- [ ] Correlation-ID reuse from `x-correlation-id` header, or generate if absent.
- [ ] Exposed as a subpath export; framework declared as a `peerDependency`.
- [ ] Integration test: a request flows through the adapter and a `record()` call
      inside a handler picks up the captured context.

**Done when:** an end-to-end request in that one framework produces a correctly
contextualized event. (Other adapters are later, separate phases.)

---

## Phase 6 — Database: Schema & Hypertable
**Doc:** Database Design (TimescaleDB — full)

- [ ] `audit_events` table with all columns, CHECK constraints, and
      `PRIMARY KEY (occurred_at, id)`.
- [ ] `create_hypertable(...)` on `occurred_at`.
- [ ] Retention and compression policies.
- [ ] `dead_letter_events` plain table.
- [ ] The starter set of indexes (correlation/type/entity/service); defer the rest.
- [ ] Migration scripts checked in and runnable.

**Done when:** the schema applies cleanly against a TimescaleDB instance and the
hypertable + policies are active.

---

## Phase 7 — Worker: Consume, Validate, Persist
**Doc:** RabbitMQ + Worker §4, §5, §6

- [ ] Standalone Worker service consuming `audit.events.q` with prefetch.
- [ ] Message validation (schema check) → valid vs permanently-invalid fork.
- [ ] Idempotent persistence: `INSERT ... ON CONFLICT (occurred_at, id) DO NOTHING`
      (dedup at the DB, **not** in memory).
- [ ] Ack on success.
- [ ] Unit/integration tests: happy path, **redelivery produces no duplicate**,
      malformed message is recognized as permanent failure.

**Done when:** events consumed from the queue land in `audit_events` exactly once,
even under redelivery.

---

## Phase 8 — Worker: Retry & Dead Letter
**Doc:** RabbitMQ + Worker §3.3, §7, §8

- [ ] Retry/DLQ topology: `audit.retry.dlx`, `audit.retry.q` (TTL-requeue),
      `audit.dead.q`.
- [ ] Transient vs permanent failure classification drives retry-vs-DLQ.
- [ ] Retry counter in headers; max-retries → terminal DLQ.
- [ ] Drain `audit.dead.q` into `dead_letter_events`.
- [ ] Tests: transient failure retries then recovers; permanent failure goes
      straight to DLQ; exhausted retries land in `dead_letter_events`.

**Done when:** no message that entered RabbitMQ is ever silently lost — it's
persisted or captured in `dead_letter_events`.

---

## Phase 9 — Containerization (local dev)
**Doc:** Deployment Architecture *(to be written)*

- [ ] `Dockerfile` for the Worker.
- [ ] `docker-compose.yml` bringing up Worker + RabbitMQ + TimescaleDB (+ Grafana)
      with one command.
- [ ] `.env.example` documenting all required environment variables.
- [ ] Everything wired via env vars (12-factor) — no hardcoded connection strings.

**Done when:** `docker compose up` yields a working local pipeline end-to-end.

---

## Phase 10 — Pipeline Observability
**Doc:** RabbitMQ + Worker §11 · Grafana & Observability *(to be written)*

- [ ] Worker metrics: processed / failed / retried / dead-lettered, insert latency,
      queue depth.
- [ ] Basic Grafana dashboard(s) over TimescaleDB.

**Done when:** the pipeline's own health is visible in Grafana.

---

## Later Phases (not yet scheduled)

- Additional framework adapters (Fastify, NestJS, Next.js) — each its own phase.
- Read API (querying events) — after the write path is solid.
- Terraform / production deployment.
- Continuous aggregates for dashboards.
- PII erasure tooling.

These are deliberately deferred; do not start them without explicit assignment.

---

## Notes for the Agent

- **One phase at a time.** Finish, get it reviewed, then move on.
- **Read the linked doc section before coding** — the design is already decided.
- **Reuse shared types** (Phase 0) everywhere; never redeclare the event contract.
- **Never commit** — leave changes in the working tree for the architect.
- **Flag, don't guess**, on anything touching a fixed contract (`AGENTS.md` §0.2).