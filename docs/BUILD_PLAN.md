# BUILD_PLAN.md

Ordered build plan for the Audit & Business Observability Platform.

> **Note (this revision):** phases 0–8 below are complete and reflect what is
> actually implemented, including several additions made after the original
> phase descriptions were written (payload masking, size limiting, lifecycle
> shutdown, warnings, configurable Express adapter, schema-drift test, JSDoc,
> and a runnable example app). Section references point to the current
> `docs/sdk-architecture.md` (v3). The queue/persistence module (Phase 9+)
> remains future and unimplemented — see `docs/sdk-architecture.md` §10.

This is the **shared map of what gets built and in what order**. The architect
assigns phases one at a time; the agent implements the referenced phase, notes
assumptions, and leaves the work for review (never commits — `AGENTS.md` §0.1).

Legend: `[x]` done & reviewed · `[ ]` not started

---

## Phase 0 — Repository Scaffolding  [x]
**Doc:** SDK Architecture §3

Monorepo under `packages/` with workspaces, shared strict TypeScript config,
shared types package (`@tnet06/mapa-audit-types`), lint/format config, Vitest
configured at the workspace root.

---

## Phase 1 — Core: Context Storage  [x]
**Doc:** SDK Architecture §5.1

`AsyncLocalStorage`-based `RequestContext` + `getContext()` in `core/storage.ts`.
Tests prove per-request isolation under concurrency.

---

## Phase 2 — Core: Transport Contract  [x]
**Doc:** SDK Architecture §5.2

`Transport` interface in `core/transport.ts`: `send(event)` plus an **optional**
`close?(): Promise<void>` for transports that need to drain pending work before
shutdown (added after the original contract — see Phase 6b).

---

## Phase 3 — Core: Event Assembly & Dispatch  [x]
**Doc:** SDK Architecture §5.3, §5.4, §5.5

Originally a single `configureAudit()`/`record()` pair in `core/configure.ts`.
Reorganized (Phase 7a) into:
- `core/audit-instance.ts` — `createAudit()`, the creational factory.
- `core/record.ts` — `buildAuditEvent()`, `sendFireAndForget()` (fan-out,
  per-transport isolation), payload masking/size-limiting (Phase 8b), and the
  public `record()` shortcut.
- `core/global-audit.ts` — the global convenience singleton (Phase 7b).

`configure.ts` no longer exists.

---

## Phase 4 — Transport: Console  [x]
**Doc:** SDK Architecture §6.1

`ConsoleTransport` — `process.stdout`/`process.stderr` (not `console.log`),
severity-based routing (`error`/`critical` → stderr), nested JSON, no
flattening. No `close()` (nothing to drain). Default transport when none is
configured.

---

## Phase 5 — First Framework Adapter (Express)  [x]
**Doc:** SDK Architecture §7.1

`expressAdapter()` — automatic context capture via `contextStore.run()`.
Originally minimal; later made configurable (Phase 8a) with
`correlationIdHeader`, `causationIdHeader`, and `extractActor`.

**Milestone reached:** the SDK is usable end-to-end with zero infrastructure.

---

## Phase 6 — Transport: File  [x]
**Doc:** SDK Architecture §6.2

`FileTransport` — formats `'jsonl'` (default), `'csv'` (via the shared
`flatten()` helper and canonical `AUDIT_EVENT_CSV_COLUMNS` schema), and
`'text'` (deliberately minimal, human-readable). XLSX was evaluated and
explicitly dropped (binary format, poor fit for append-only writes) — never
implemented.

### Phase 6a — Robustness hardening  [x]
- One-time cached directory creation (`#ensureDirectory`), not repeated per
  `send()`.
- Chained writes (`#pendingWrite`) preserve append order under fire-and-forget.
- CSV header race condition fixed: an in-memory flag (`#headerWritten`)
  replaces per-write filesystem checks. **Known limitation, by design:**
  protects a single instance/process; multiple `FileTransport` instances (or
  processes) writing the same path can still race — share one instance rather
  than creating several pointed at the same file.
- Write failures reported via `emitAuditWarning()` (Phase 8c), not swallowed.

### Phase 6b — Lifecycle (`close`/`shutdown`)  [x]
- `Transport.close?()` (Phase 2 addendum) implemented by `FileTransport`,
  draining `#pendingWrite` before resolving.
- `AuditInstance.shutdown()` calls `close()` on every transport that has one,
  in parallel; idempotent (concurrent calls await the same in-flight shutdown).
- `shutdownGlobalAudit()` mirrors this for the global singleton.

---

## Phase 7 — Hybrid API: Creational + Global  [x]
**Doc:** SDK Architecture §2

Originally a single module-global `configureAudit()`. Redesigned into two
complementary APIs sharing one implementation:

### Phase 7a — `createAudit()` factory  [x]
Isolated instances (`AuditInstance`: `record()`, `shutdown()`, `getInfo()`),
state held in a closure — no module-level mutable state per instance.

### Phase 7b — Global convenience singleton  [x]
`initGlobalAudit()`, `record()`, `shutdownGlobalAudit()`, `resetGlobalAudit()`
— a thin wrapper storing one `createAudit()` instance at module scope. The
global is deliberately **not mutable in place** after `initGlobalAudit()` (no
add/remove-transport API on the live global) — see SDK Architecture §2.2.

### Phase 7c — `getGlobalAudit()` inspection getter  [x]
Returns a read-only `GlobalAuditInfo` snapshot (`configured`, `serviceName`,
`environment`, `transportCount`) — never the instance itself, never a mutable
reference. `transportCount` is derived from the instance's real transports
array via `AuditInstance.getInfo()` (not recomputed separately) to avoid a
second source of truth.

### Phase 7d — API naming pass  [x]
Renamed for clarity: `configureAudit` → `initGlobalAudit`; internal
`recordWithConfiguredAudit` → `recordGlobal`. All global-scoped functions carry
"Global" in their name to visually distinguish them from the creational API.

---

## Phase 8 — Security & Robustness Hardening  [x]
**Doc:** SDK Architecture §5.4, §5.6

### Phase 8a — Express adapter configurability  [x]
`ExpressAdapterOptions`: `correlationIdHeader`, `causationIdHeader` (with
`causationId` extraction added — it existed on `RequestContext` but was never
populated before this), `extractActor` (fully replaces default extraction when
provided). Default `actor.type` now correctly set to `'user'` (`ActorType`)
when an authenticated actor is captured.

### Phase 8b — Payload masking & size limiting  [x]
- `maskedFields?: string[]` on `AuditConfig` — dot-notation paths of arbitrary
  depth (e.g. `'user.ssn'`, `'payment.card.cvv'`), not just first-level keys.
  Deep-clones (`structuredClone`) only when masking is configured; navigates
  paths defensively (missing/non-object/`null`/array segments abort silently,
  no throw). Array-element masking is explicitly **not supported**
  (documented limitation).
- `maxPayloadSize?: number` (default 1MB) — oversized payloads replaced with a
  `{ truncated, originalSizeBytes, maxSizeBytes }` marker, applied after
  masking.
- Neither mutates the caller's original payload object, at any depth.

### Phase 8c — Visible failure (no silent error swallowing)  [x]
- `emitAuditWarning()` / `errorMessage()` extracted to `core/warnings.ts`,
  shared between transport-dispatch failures (`record.ts`) and file-write
  failures (`transports/file.ts`) — single implementation, not duplicated.
- `record()` (global) warns exactly **once** per process if called before
  `initGlobalAudit()`, instead of silently discarding events forever;
  `resetGlobalAudit()` resets the warned-once flag for test isolation.

### Phase 8d — Schema drift protection  [x]
`test/core/flatten.sync.test.ts` — verifies a fully-populated `AuditEvent`
flattens to exactly the `AUDIT_EVENT_CSV_COLUMNS` key set (no more, no fewer),
catching silent drift between the two hand-maintained schemas.

### Phase 8e — JSDoc  [x]
Public API surface documented (`AuditConfig`, `RecordInput`, `createAudit`,
`AuditInstance`, global functions, `Transport`, both transports,
`ExpressAdapterOptions`), including guidance on when to use the global API vs.
`createAudit()`.

---

## Phase 8f — Example App  [x]
**Doc:** SDK Architecture §8

`examples/express-demo/` — a from-scratch Express app in the monorepo
workspace, consuming the SDK directly (not an external install). Demonstrates:
automatic context capture, actor extraction, first-level and nested
`maskedFields`, `maxPayloadSize` truncation, transport selection via env var
(console/file-jsonl/file-csv/file-text), and graceful shutdown draining
pending writes on `SIGINT`/`SIGTERM`.

---

## — — — QUEUE / PERSISTENCE MODULE (future, unimplemented) — — —

Everything below remains **future, opt-in, self-hosted**, exactly as originally
scoped. Nothing in this section has been built. See SDK Architecture §10 and
the companion documents (`platform-general-overview.md`, `database-design.md`,
`rabbitmq-worker-architecture.md`) — those should be read as forward-looking
design, not as current SDK behavior.

## Phase 9 — Queue Transport (SDK side)  [ ]
**Doc:** SDK Architecture §10 · RabbitMQ + Worker Architecture

`QueueTransport` in its own package (e.g. `@tnet06/mapa-audit-transport-queue`),
implementing the same `Transport` interface. Not started.

## Phase 10 — Database: Schema & Hypertable  [ ]
**Doc:** Database Design (TimescaleDB)

Not started. Note: before implementation, reconcile `database-design.md`
against the current `AuditEvent` shape — the SDK's `correlationId` is optional
(events recorded outside a request context may lack one), while the current DB
design marks it `NOT NULL`; and HTTP-context columns should not be scoped only
to `event_type = 'request'`, since the Express adapter attaches request context
to business/security/system events too, not only a dedicated "request" type.

## Phase 11 — Worker: Consume, Validate, Persist  [ ]
**Doc:** RabbitMQ + Worker Architecture

Not started.

## Phase 12 — Worker: Retry & Dead Letter  [ ]
**Doc:** RabbitMQ + Worker Architecture

Not started.

## Phase 13 — Containerization & Self-Hosted Infra  [ ]
**Doc:** Deployment Architecture *(to be written)*

Not started.

## Phase 14 — Pipeline Observability  [ ]
**Doc:** RabbitMQ + Worker Architecture §11 · Grafana & Observability *(to be written)*

Not started.

---

## Later / Unscheduled

- Additional framework adapters: Fastify, NestJS, a manual-context helper for
  non-HTTP entry points (jobs, CLI scripts).
- File rotation (`maxSize`/`maxFiles`) for `FileTransport`.
- Array-element masking in `maskedFields`.
- Read API for querying persisted events (depends on Phase 10+).
- Continuous aggregates for dashboards (depends on Phase 10+).
- Multi-tenant isolation hardening (schema already carries `tenant_id`, once
  Phase 10 exists).

Do not start these without explicit assignment.

---

## Publication Checklist (separate from feature phases — do when ready to publish)

Deliberately deferred, not forgotten. When the decision is made to publish:

- [ ] `packages/sdk/package.json` and `packages/types/package.json`: remove
      `private: true`, set a real `version` (in sync between the two — fixed
      versioning, not independent), add `license` (MIT), `repository`,
      `engines`.
- [ ] Add `publishConfig.access: "public"` (required for scoped packages).
- [ ] Add a `prepublishOnly` script (`npm run build`).
- [ ] Root `README.md` (installation, quick example, link to
      `examples/express-demo/`, troubleshooting, known limitations).
- [ ] Confirm `tsc -b` (already a single command via project references) still
      builds cleanly with all current packages.

---

## Notes for the Agent

- **One phase at a time.** Finish, get it reviewed, then move on.
- **Read the linked doc section before coding** — `docs/sdk-architecture.md` is
  the current source of truth for the SDK; the queue/DB/worker documents
  describe a **future, unimplemented** module — do not treat them as
  describing current behavior.
- **Reuse shared types** — never redeclare the event contract (`AGENTS.md` §3).
- **Adapters and transports are independent** — adding one must not touch the
  other.
- **`id` is generated client-side** in `record()`/`buildAuditEvent()` —
  preserved across all transports for the future queue transport's
  idempotency.
- **Never commit** — leave changes in the working tree for the architect.
- **Flag, don't guess**, on anything touching a fixed contract (`AGENTS.md`
  §0.2).