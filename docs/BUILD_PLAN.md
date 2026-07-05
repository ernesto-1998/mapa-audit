# BUILD_PLAN.md

Ordered build plan for the Audit & Business Observability Platform.

This is the **shared map of what gets built and in what order**. It is not a
detailed spec — each phase points to the design document that specifies it. The
architect assigns phases one at a time; the agent implements the referenced phase,
notes assumptions, and leaves the work for review (never commits — `AGENTS.md`
§0.1).

**Guiding principle of the ordering:** build the *valuable, zero-infrastructure*
path first (context capture + console/file transports), and defer the complex,
infrastructure-bearing queue/DB path to the end as a separate module. Each phase
should ship something demonstrable.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done & reviewed

---

## Phase 0 — Repository Scaffolding  (already done)
**Doc:** SDK Architecture §3

- [] Monorepo under `packages/` with workspaces.
- [] Shared TypeScript strict config.
- [] Shared types module (`@tnet06/mapa-audit-types`) — single source of truth
      for the event contract.
- [] Lint/format config, .gitignore/.gitattributes.

**Note:** this scaffolding is transport-agnostic and remains valid under the
pluggable-transport approach. No rework needed.

---

## Phase 1 — Core: Context Storage
**Doc:** SDK Architecture §4.1

- [ ] `AsyncLocalStorage` instance and `RequestContext` interface.
- [ ] `getContext()` helper.
- [ ] Unit tests: context isolated per async chain, readable deep in the stack,
      two concurrent contexts never mix, absent-context handled gracefully.

**Done when:** context can be set for a run and read from nested async calls, with
proven isolation between concurrent runs.

---

## Phase 2 — Core: Transport Contract
**Doc:** SDK Architecture §4.2

- [ ] `Transport` interface (`send(event)`).
- [ ] `AuditEvent` type wired to the shared types package (do not redeclare —
      import from `@tnet06/mapa-audit-types`).
- [ ] Unit tests: a stub transport receives a well-formed event.

**Done when:** the core depends only on the `Transport` interface, with no concrete
transport referenced.

---

## Phase 3 — Core: record() + configure()
**Doc:** SDK Architecture §4.3, §4.4

- [ ] `record(input)`: **generates `id` client-side**, merges context, sets
      `occurredAt`, applies default severity, hands the event to the active
      transport.
- [ ] Fire-and-forget: synchronous to the caller, never awaited, never throws.
- [ ] `configureAudit(config)`: sets service metadata and selects the transport;
      validates `environment`.
- [ ] Unit tests: id present and client-generated; context merge correct; a
      throwing transport never propagates to the caller.

**Done when:** a `record()` call produces a well-formed event and delivers it to a
configured transport without blocking or throwing.

---

## Phase 4 — Transport: Console
**Doc:** SDK Architecture §5.1

- [ ] `ConsoleTransport` implementing `Transport`.
- [ ] Used as the zero-config default when no transport is provided.
- [ ] Unit tests: event serialized and emitted.

**Done when:** `npm install` + `configureAudit` with no transport produces
structured events on the console out of the box.

---

## Phase 5 — First Framework Adapter
**Doc:** SDK Architecture §6

- [ ] Implement **one** adapter first (the primary framework — likely NestJS or
      Express). Build `RequestContext` from the request, run the rest inside
      `contextStore.run(...)`.
- [ ] Correlation-ID reuse from `x-correlation-id`, generate if absent.
- [ ] Subpath export; framework as a `peerDependency`.
- [ ] Integration test: a request flows through the adapter and a `record()` in a
      handler picks up the captured context, same correlation ID throughout.

**Done when:** an end-to-end request in that framework, with the console transport,
produces a correctly correlated event.

**Milestone:** at the end of Phase 5 the SDK is genuinely usable and valuable with
zero infrastructure. This is the first "shippable" point.

---

## Phase 6 — Transport: File
**Doc:** SDK Architecture §5.2

- [ ] `FileTransport` with JSONL as the default format.
- [ ] Optional CSV formatter.
- [ ] Unit tests: JSONL append correctness; CSV formatting; produces a
      valid file.

**Done when:** events can be persisted to a local file in JSONL/CSV, with XLSX
export available.

---

## Phase 7 — Additional Adapters (each its own sub-phase)
**Doc:** SDK Architecture §6

- [ ] Express (if not the first) · Fastify · Node manual-context helper.
- [ ] Each: subpath export, peer dependency, integration test.

**Done when:** the SDK supports the target frameworks, each independently tested.

---

## Phase 8 — Packaging & Publish (console/file SDK)
**Doc:** SDK Architecture §9

- [ ] Finalize `exports`, `files`, `main`/`types` for SDK and types packages.
- [ ] Add `LICENSE` (MIT), `publishConfig.access: public`, real versions.
- [ ] Publish `@tnet06/mapa-audit-sdk` + `@tnet06/mapa-audit-types` together.

**Done when:** the console/file SDK is installable from the registry by others.

---

## — — — QUEUE / PERSISTENCE MODULE (the advanced, infrastructure path) — — —

Everything below is the **opt-in, self-hosted** queue transport and its backing
pipeline. Deliberately built last; not required for the SDK to be useful.

## Phase 9 — Queue Transport (SDK side)
**Doc:** SDK Architecture §5.3 · RabbitMQ + Worker §3

- [ ] `QueueTransport` in its **own package**
      (`@tnet06/mapa-audit-transport-queue`), carrying `amqp-connection-manager`.
- [ ] Publishes to the `audit.events` topic exchange; best-effort producer buffer.
- [ ] Implements the same `Transport` interface — drop-in with the existing core.
- [ ] Tests: publish path, buffer-on-outage, never throws into caller.

**Done when:** swapping the transport to `QueueTransport` publishes events to
RabbitMQ with no other code change.

---

## Phase 10 — Database: Schema & Hypertable
**Doc:** Database Design (TimescaleDB)

- [ ] `audit_events` table, CHECK constraints, `PRIMARY KEY (occurred_at, id)`.
- [ ] `create_hypertable` on `occurred_at`; retention + compression policies.
- [ ] `dead_letter_events` plain table.
- [ ] Starter indexes; migrations runnable.

**Done when:** the schema applies cleanly on TimescaleDB with hypertable + policies
active.

---

## Phase 11 — Worker: Consume, Validate, Persist
**Doc:** RabbitMQ + Worker §4, §5, §6

- [ ] Standalone Worker consuming `audit.events.q` with prefetch.
- [ ] Validation → valid vs permanently-invalid fork.
- [ ] Idempotent persistence: `ON CONFLICT (occurred_at, id) DO NOTHING` (dedup at
      the DB, not in memory).
- [ ] Tests: happy path, **redelivery produces no duplicate**, malformed message
      recognized as permanent failure.

**Done when:** events consumed from the queue land in `audit_events` exactly once.

---

## Phase 12 — Worker: Retry & Dead Letter
**Doc:** RabbitMQ + Worker §3.3, §7, §8

- [ ] Retry/DLQ topology (`audit.retry.dlx`, `audit.retry.q` TTL-requeue,
      `audit.dead.q`).
- [ ] Transient vs permanent classification drives retry-vs-DLQ.
- [ ] Drain `audit.dead.q` into `dead_letter_events`.
- [ ] Tests: transient retries then recovers; permanent goes straight to DLQ;
      exhausted retries land in `dead_letter_events`.

**Done when:** nothing that entered RabbitMQ is ever silently lost.

---

## Phase 13 — Containerization & Self-Hosted Infra
**Doc:** Deployment Architecture *(to be written)*

- [ ] `Dockerfile` for the Worker.
- [ ] `docker-compose.yml`: Worker + RabbitMQ + TimescaleDB (+ Grafana), one
      command.
- [ ] `.env.example`; everything via env vars (12-factor).
- [ ] Terraform for a cloud deployment (optional, later).

**Done when:** a consumer of the queue transport can stand up their own pipeline
with `docker compose up`.

---

## Phase 14 — Pipeline Observability
**Doc:** RabbitMQ + Worker §11 · Grafana & Observability *(to be written)*

- [ ] Worker metrics: processed / failed / retried / dead-lettered, queue depth.
- [ ] Grafana dashboards over TimescaleDB.

**Done when:** the queue pipeline's health is visible in Grafana.

---

## Later / Unscheduled

- Read API for querying events.
- Continuous aggregates for dashboards.
- PII hashing hook in the SDK; per-user erasure tooling.
- Multi-tenant isolation hardening (schema already carries `tenant_id`).

Do not start these without explicit assignment.

---

## Notes for the Agent

- **One phase at a time.** Finish, get it reviewed, then move on.
- **Read the linked doc section before coding.**
- **Reuse shared types** — never redeclare the event contract (`AGENTS.md` §3).
- **Adapters and transports are independent** — adding one must not touch the other.
- **`id` is generated client-side** in `record()` — preserved across all transports
  for the queue transport's idempotency.
- **Never commit** — leave changes in the working tree for the architect.
- **Flag, don't guess**, on anything touching a fixed contract (`AGENTS.md` §0.2).