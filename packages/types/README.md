# @tnet06/mapa-audit-types

Shared TypeScript and runtime contracts for Mapa Audit events.

This package is the single source of truth for the `AuditEvent` shape, canonical
classification values, runtime value arrays, and the `Transport` interface used
by the SDK, transports, event consumers, and future worker integrations.
Centralizing these contracts prevents producers and consumers from maintaining
incompatible local definitions of the same audit event.

This package does not record events, capture HTTP context, publish to RabbitMQ,
write files, validate inputs automatically, or persist data. Those
responsibilities live in other packages.

## Installation

```sh
npm install @tnet06/mapa-audit-types
```

Most applications that only use `@tnet06/mapa-audit-sdk` do not need to install
this package directly because the SDK depends on it.

Install or import it directly when building custom transports, consumers,
worker-style processors, or tooling that needs to compile against the shared
event contract. The package has no Express, Fastify, NestJS, or RabbitMQ
dependency.

## What This Package Exports

| Export            | Kind                 | Purpose                                    |
| ----------------- | -------------------- | ------------------------------------------ |
| `AuditEvent`      | TypeScript interface | Canonical nested audit event shape         |
| `Transport`       | TypeScript interface | Contract implemented by event destinations |
| `EventType`       | TypeScript type      | Union derived from `eventTypes`            |
| `EventSeverity`   | TypeScript type      | Union derived from `eventSeverities`       |
| `EventOutcome`    | TypeScript type      | Union derived from `eventOutcomes`         |
| `ActorType`       | TypeScript type      | Union derived from `actorTypes`            |
| `Environment`     | TypeScript type      | Union derived from `environments`          |
| `eventTypes`      | Runtime value        | Canonical event domain/category values     |
| `eventSeverities` | Runtime value        | Canonical event gravity values             |
| `eventOutcomes`   | Runtime value        | Canonical operation result values          |
| `actorTypes`      | Runtime value        | Canonical actor classification values      |
| `environments`    | Runtime value        | Canonical runtime environment values       |

Type aliases and interfaces exist for TypeScript. The arrays exist at runtime
and can also be used from JavaScript or from custom validation code. This package
exports the values; it does not export validation helper functions.

## Classification Model

The classification fields are independent axes:

| Field                 | Meaning             | Values                                                        |
| --------------------- | ------------------- | ------------------------------------------------------------- |
| `eventType`           | Domain/category     | `request`, `business`, `audit`, `error`, `security`, `system` |
| `severity`            | Gravity             | `debug`, `info`, `warn`, `error`, `critical`                  |
| `outcome`             | Operation result    | `success`, `failure`, `partial`                               |
| `actor.type`          | Actor category      | `user`, `service`, `system`, `job`                            |
| `service.environment` | Runtime environment | `development`, `staging`, `production`                        |

These values are case-sensitive. Do not collapse or reinterpret the axes: a
business event can have `severity: 'error'` and `outcome: 'failure'`.

```ts
import type { AuditEvent } from '@tnet06/mapa-audit-types';

const event: AuditEvent = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  eventType: 'business',
  eventName: 'payment.capture_failed',
  severity: 'error',
  outcome: 'failure',
  occurredAt: '2026-09-07T00:00:00.000Z',
  service: {
    name: 'payments-api',
    environment: 'production'
  },
  entity: {
    type: 'payment',
    id: 'pay-123'
  }
};
```

## AuditEvent

`AuditEvent` is the canonical nested event received by transports and consumers.

```ts
interface AuditEvent {
  readonly id: string;
  correlationId?: string;
  causationId?: string;
  eventType: EventType;
  eventName: string;
  severity: EventSeverity;
  outcome?: EventOutcome;
  readonly occurredAt: string;
  payloadSchemaVersion?: number;
  service: {
    name: string;
    version?: string;
    environment: Environment;
    instanceId?: string;
  };
  request?: {
    httpMethod?: string;
    endpoint?: string;
    routePattern?: string;
    ipAddress?: string;
    userAgent?: string;
  };
  actor?: {
    type?: ActorType;
    userId?: string;
    userRole?: string;
    tenantId?: string;
  };
  entity?: {
    type?: string;
    id?: string;
  };
  payload?: Record<string, unknown>;
}
```

Required root fields are `id`, `eventType`, `eventName`, `severity`,
`occurredAt`, and `service`. Most contextual groups are optional because not all
events are emitted from an HTTP request or authenticated actor.

`id` and `occurredAt` are marked `readonly`. That is a TypeScript surface-level
restriction; it does not make the entire event deeply immutable at runtime.

The event remains nested. Any flattening for CSV, database rows, or other output
formats belongs at the serialization boundary, not in this package.

When events are produced through `@tnet06/mapa-audit-sdk`, the SDK generates
`id` and `occurredAt`. This types package only defines the contract; it does not
generate values. A field existing on `AuditEvent` also does not mean the current
SDK exposes it through its recording input. For example,
`payloadSchemaVersion` is part of the shared contract, but the SDK's
`RecordInput` does not currently expose a way to set it. `service.instanceId` is
also part of the contract, but the SDK's `AuditConfig` does not currently expose
configuration for it.

### Event Groups

- `service`: metadata for the emitting service.
- `request`: HTTP metadata captured by framework adapters when available.
- `actor`: who or what performed the action.
- `entity`: domain object affected by the action.
- `payload`: custom event data as `Record<string, unknown>`.

For example, if an administrator changes another user's role, `actor` is the
administrator and `entity` identifies the target user.

## Transport

`Transport` is the destination contract implemented by SDK transports and
external transport packages.

```ts
import type { AuditEvent, Transport } from '@tnet06/mapa-audit-types';

class MyTransport implements Transport {
  send(event: AuditEvent): void | Promise<void> {
    // Deliver the already-built event.
    void event;
  }

  async close(): Promise<void> {
    // Drain or close owned resources when applicable.
  }
}
```

`send()` receives an already-built `AuditEvent` and may be synchronous or
asynchronous. `close()` is optional and exists for transports that need to drain
or close owned resources during shutdown.

The interface does not prescribe a destination, retry policy, buffering model,
persistence layer, or delivery guarantee. Error containment is handled by the
SDK or dispatcher that calls the transport, not by this types package.

## Runtime Constants

Runtime arrays let JavaScript consumers and custom tooling validate values
without duplicating canonical strings.

```ts
import { eventTypes, type EventType } from '@tnet06/mapa-audit-types';

function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && eventTypes.includes(value as EventType);
}
```

This is consumer-owned validation. The package exports the canonical arrays but
does not export an `isEventType()` helper.

## Usage Examples

### Custom Transport

```ts
import type { AuditEvent, Transport } from '@tnet06/mapa-audit-types';

export class HttpAuditTransport implements Transport {
  async send(event: AuditEvent): Promise<void> {
    await fetch('https://audit.example.test/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(event)
    });
  }

  async close(): Promise<void> {
    // Drain or close owned resources when applicable.
  }
}
```

This example only demonstrates the shared `Transport` shape. It does not include
authentication, retries, buffering, or guaranteed delivery.

### Event Consumer

```ts
import type { AuditEvent } from '@tnet06/mapa-audit-types';

export function handleAuditEvent(event: AuditEvent): void {
  // Consume the canonical event.
  process.stdout.write(`${event.eventType}: ${event.eventName}\n`);
}
```

Consumers can depend on `AuditEvent` without depending on the SDK runtime.

## Related Packages

- `@tnet06/mapa-audit-sdk`: builds events, captures request context, applies
  payload safety rules, and dispatches to transports.
- `@tnet06/mapa-audit-transport-rabbitmq`: separate RabbitMQ publisher transport
  that implements `Transport`.

For broader project documentation, see the repository:
https://github.com/ernesto-1998/mapa-audit

## License

MIT. See [LICENSE](./LICENSE).
