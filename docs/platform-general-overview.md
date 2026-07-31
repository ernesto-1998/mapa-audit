# Audit & Business Observability Platform
## Platform Design Overview (Current State — v2)

**Status:** Reflects what is implemented today, with the future pipeline clearly
marked as such
**Audience:** Engineering, anyone evaluating adoption
**Companion to:** SDK Architecture (current, implemented), Database Design
(future), RabbitMQ + Worker Architecture (future)

> **Superseded content notice:** earlier drafts of this document presented a
> `SDK → RabbitMQ → Worker → PostgreSQL` pipeline as the platform's current,
> central architecture, described a public API (`initAuditSDK`) that never
> existed, and referenced PostgreSQL with `pg_partman` where the actual storage
> decision is TimescaleDB. This revision corrects all three and separates what
> is **implemented today** from what is **future, opt-in design**.

---

### 1. What this platform is

A small ecosystem for structured audit, business, error, and security events in
backend services, built from independently useful pieces:

| Piece | Status | What it does |
|---|---|---|
| **SDK** (`@tnet06/mapa-audit-sdk`) | ✅ **Implemented, usable today** | Automatic request-context capture, a structured event model, built-in data safety (masking, size limits), pluggable transports (console, file today) |
| **Queue transport** (`@tnet06/mapa-audit-transport-queue`) | 🔜 Future, separate package | Publishes events to a message broker instead of console/file |
| **Worker** | 🔜 Future, separate deployable service | Consumes the queue, validates, persists to a database |
| **Database schema** (TimescaleDB) | 🔜 Future | Where the Worker persists events, if adopted |

**The SDK works completely on its own, with zero additional infrastructure.**
A team can install it, call `initGlobalAudit()` once, and start recording
structured events to console or a local file — nothing else to deploy, nothing
else to operate. The queue/Worker/database pipeline is an **optional, separate
extension** for teams that want centralized, queryable, long-term storage — not
a requirement to get value from the SDK.

This is a deliberate ordering, not an accident: build the piece with the
highest value-to-effort ratio first (structured, context-aware events with
safe defaults), ship it, and let the persistence pipeline be adopted
independently and later, by whoever actually needs it.

---

### 2. What "the SDK" gives you (implemented)

The SDK's core value has nothing to do with where events end up — it is what
happens *before* that:

- **Automatic request-context capture** — correlation ID, causation ID,
  actor (who), and request metadata (method, endpoint, IP, user agent),
  captured once per request via an adapter (`AsyncLocalStorage`-based) and
  merged into every event recorded during that request, without the caller
  passing any of it manually.
- **A structured, nested event model** (`AuditEvent`) — not free-text logs.
  `eventType`, `eventName`, `outcome`, `entity`, `payload`, all typed.
- **Built-in data safety** — `maskedFields` (dot-notation, nested paths) redact
  sensitive payload fields before any transport sees the event;
  `maxPayloadSize` replaces oversized payloads with a truncation marker
  instead of forwarding arbitrarily large data.
- **Pluggable transports** — `ConsoleTransport` and `FileTransport`
  (jsonl/csv/text) today, each implementing the same small interface. Multiple
  transports can be configured together (fan-out): the same event can go to
  console and a file simultaneously, with one transport's failure never
  affecting the others.
- **Explicit lifecycle** — `shutdown()` drains any transport with pending work
  (e.g. buffered file writes) before a process exits, so events are not lost
  on graceful shutdown.
- **Visible failure** — transport errors and misconfiguration emit
  `process.emitWarning` instead of failing silently, while never throwing into
  the host application (fire-and-forget by design).

See `sdk-architecture.md` for the full technical reference, and
`examples/express-demo/` for a runnable demonstration of all of the above.

---

### 3. The public API (as implemented — not `initAuditSDK`)

Earlier drafts of this document referenced a two-function contract,
`initAuditSDK(config)` / `record(event)`, that was never built. The actual
public surface is a **hybrid** of a global convenience API and a creational
API — see `sdk-architecture.md` §2 for the full rationale. Summary:

```ts
// Global — the common case: one configuration per process, initialized once
import { initGlobalAudit, record, shutdownGlobalAudit } from '@tnet06/mapa-audit-sdk';

initGlobalAudit({
  serviceName: 'recipes-api',
  environment: 'production',
  transports: [new ConsoleTransport()],
  maskedFields: ['creditCard', 'user.ssn'],
});

record({
  eventType: 'business',
  eventName: 'recipe.updated',
  outcome: 'success',
  entity: { type: 'recipe', id: recipe.id },
  payload: { changedFields: ['title'] },
});
```

```ts
// Creational — isolated instances, for tests or multiple independent configs
import { createAudit } from '@tnet06/mapa-audit-sdk';
const audit = createAudit({ serviceName: 'recipes-api', environment: 'test', transports: [...] });
audit.record({ ... });
```

Adapters connect a framework to this API by populating request context
automatically. **Express is implemented today** (`expressAdapter`, fully
configurable: custom headers, custom actor extraction). Fastify, NestJS, and a
Node.js `http`-module adapter (for frameworkless services) remain planned —
all designed to stay lightweight and live inside the main SDK package (no
heavy dependencies), unlike the queue transport (§4).

---

### 4. The optional pipeline: queue, Worker, database (future, not implemented)

For teams that want events centrally persisted, queryable, and retained beyond
a local file, the design calls for three additional, **separate** pieces —
none of which exist yet:

```
Your service (SDK)  →  Queue transport  →  [ message broker ]  →  Worker  →  Database
   (implemented)         (future, own          (RabbitMQ,        (future,     (future,
                          npm package)           self-hosted)      separate     TimescaleDB —
                                                                    process)     see below)
```

- **Queue transport** — a `Transport` implementation (e.g.
  `RabbitMQTransport`) that publishes events to a message broker instead of
  console/file. Ships as its **own npm package**
  (`@tnet06/mapa-audit-transport-queue`), because it carries a real,
  non-trivial client dependency (an AMQP client library) — consumers who only
  use console/file transports never install it. It implements the *same*
  `Transport` interface as everything else; from the SDK core's perspective,
  it is interchangeable with `FileTransport`.
- **Worker** — a separate, deployable service (its own process, its own
  Docker image, not an npm package) that consumes the queue, validates
  incoming events, and persists them. This is a **reference implementation**,
  not something the SDK forces on anyone: a team adopting the queue transport
  can run this Worker as-is, adapt it, or write their own — the only real
  contract is the shape of the message on the queue (the shared `AuditEvent`
  type), not a code dependency on this specific Worker.
- **Database** — the Worker's reference implementation persists to
  **TimescaleDB** (a time-series-oriented extension of PostgreSQL), chosen for
  its native support of time-partitioned hypertables, compression, and
  retention policies — a good structural fit for audit events, which are
  fundamentally time-series data accessed mostly by time range. Earlier
  drafts of this document referenced plain PostgreSQL with manual
  `pg_partman`-based partitioning; that was an inconsistency with the actual
  decision (documented in `database-design.md`) — TimescaleDB is the current
  design, not manually-managed partitioning.

**None of this — queue transport, Worker, database schema — is implemented as
of this revision.** Design details live in `rabbitmq-worker-architecture.md`
and `database-design.md`; both should be read as forward-looking design.

#### 4.1 Why this stays optional and separate

A service using only `ConsoleTransport`/`FileTransport` never needs to know
this pipeline exists — no queue client, no broker connection, no additional
infrastructure to operate. This is deliberate: the SDK's value (structured,
context-aware, safe-by-default events) does not depend on centralized
persistence. Centralization is something teams opt into when they need
cross-service querying, long retention, or compliance-grade durability beyond
a local file — not a requirement to start using the SDK productively.

#### 4.2 What was previously incorrect about "buffering"

An earlier draft stated that the SDK buffers events in memory if the queue is
unavailable. **No such buffering exists in the SDK today**, and no
`QueueTransport` exists yet to buffer for. When the queue transport is built,
its buffering/backpressure behavior (if any) will be specified in its own
design, not assumed here.

---

### 5. Guarantees, today

Independent of whether the future pipeline is ever adopted, these hold for
every transport the SDK ships today:

- Recording an event never throws into, or blocks, the calling application
  (fire-and-forget).
- A transport failure is isolated — it never prevents delivery to other
  configured transports, and never surfaces as an exception to the caller. It
  is reported via `process.emitWarning`, never silently swallowed.
- `shutdown()` drains any transport with pending work before a process exits
  cleanly, so a graceful shutdown does not lose in-flight events.
- Sensitive payload fields, when identified via `maskedFields`, are redacted
  before any transport — including console — ever receives the event.

These guarantees are transport-agnostic by construction: they hold the same
way whether the underlying transport is `ConsoleTransport`, `FileTransport`,
or, in the future, a queue transport.

---

### 6. Status summary

| Capability | Status |
|---|---|
| Structured event model, automatic context capture | ✅ Implemented |
| Console / file transports, fan-out, lifecycle | ✅ Implemented |
| Field masking, payload size limiting | ✅ Implemented |
| Express adapter (configurable) | ✅ Implemented |
| Fastify / NestJS / Node `http` adapters | 🔜 Planned, unimplemented |
| Queue transport (RabbitMQ) | 🔜 Planned, unimplemented, separate package |
| Worker (consume, validate, persist) | 🔜 Planned, unimplemented, separate service |
| TimescaleDB schema & persistence | 🔜 Planned, unimplemented |
| Query API / dashboards over persisted events | 🔜 Depends on the above; not yet designed in detail |

See `docs/BUILD_PLAN.md` for the phase-by-phase build order and current
progress.