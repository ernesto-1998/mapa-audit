# @tnet06/mapa-audit-transport-rabbitmq

RabbitMQ transport for Mapa Audit. It implements the shared `Transport`
contract and publishes canonical `AuditEvent` objects to RabbitMQ through
`amqp-connection-manager`.

This package is only a publisher. It does not capture HTTP context, build audit
events, consume messages, write to a database, or run the future Worker. It is
published separately from `@tnet06/mapa-audit-sdk` so applications that only use
console or file output do not install RabbitMQ dependencies.

## Contents

- [Installation](#installation)
- [Public API](#public-api)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Published Message](#published-message)
- [Exchange and Topology](#exchange-and-topology)
- [Connection and Publish Behavior](#connection-and-publish-behavior)
- [Warnings](#warnings)
- [Credential Safety](#credential-safety)
- [Graceful Shutdown](#graceful-shutdown)
- [Operational Considerations](#operational-considerations)
- [Scope and Limitations](#scope-and-limitations)
- [Related Packages](#related-packages)
- [License](#license)

## Installation

For the usual SDK flow:

```sh
npm install @tnet06/mapa-audit-sdk @tnet06/mapa-audit-transport-rabbitmq
```

For custom tooling that only needs the transport package:

```sh
npm install @tnet06/mapa-audit-transport-rabbitmq
```

The transport depends directly on `@tnet06/mapa-audit-types` for `AuditEvent`
and `Transport`. `amqp-connection-manager` is a runtime dependency of this
package and is installed transitively. Express, Fastify, and NestJS are not
required by this package.

## Public API

```ts
import {
  RabbitMQTransport,
  type RabbitMQTransportOptions
} from '@tnet06/mapa-audit-transport-rabbitmq';
```

Only the root entrypoint is public. Internal warning helpers, URL sanitization
helpers, routing-key conversion, publish timeout helpers, and connection event
interfaces are implementation details.

## Quickstart

```ts
import {
  initGlobalAudit,
  record,
  shutdownGlobalAudit
} from '@tnet06/mapa-audit-sdk';
import { RabbitMQTransport } from '@tnet06/mapa-audit-transport-rabbitmq';

const connection = process.env.AUDIT_RABBITMQ_URL;

if (connection === undefined) {
  throw new Error('AUDIT_RABBITMQ_URL is required');
}

initGlobalAudit({
  serviceName: 'orders-api',
  environment: 'production',
  transports: [
    new RabbitMQTransport({
      connection
    })
  ]
});

record({
  eventType: 'business',
  eventName: 'order.created',
  outcome: 'success',
  entity: {
    type: 'order',
    id: 'order-123'
  }
});

await shutdownGlobalAudit();
```

`record()` is not awaited. It is the SDK's fire-and-forget API. Shutdown is
shown because this transport owns RabbitMQ connection resources.

## Configuration

`RabbitMQTransport` accepts these options:

| Option              | Required | Default        | Behavior                                                                                                |
| ------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `connection`        | Yes      | None           | AMQP broker URL or URL list passed to `amqp-connection-manager`.                                        |
| `exchange`          | No       | `audit.events` | Exchange that receives audit events. Declared as `topic` and durable during channel setup.              |
| `connectionOptions` | No       | None           | Passed directly to `amqp-connection-manager.connect()`. The transport does not interpret these options. |
| `publishTimeoutMs`  | No       | `5000`         | Maximum time `send()` waits for one publish before warning and returning.                               |

### `connection`

`connection` accepts a string or a string array. The value is handed to
`amqp-connection-manager`, which owns connection selection and reconnection
behavior. A list of URLs lets the dependency use its built-in multi-server
handling; this package does not define a separate selection algorithm.

Use environment variables for real URLs:

```ts
const transport = new RabbitMQTransport({
  connection: process.env.AUDIT_RABBITMQ_URL ?? 'amqp://localhost:5672/audit'
});
```

### `exchange`

The default exchange is `audit.events`. The transport creates a channel wrapper
and, during setup, declares the configured exchange as:

- type: `topic`
- durable: `true`

### `connectionOptions`

`connectionOptions` is forwarded to `amqp-connection-manager.connect()` without
custom interpretation. Common connection-manager options include heartbeat and
reconnect interval settings, but consult the dependency for the complete option
surface.

### `publishTimeoutMs`

The default publish timeout is `5000` milliseconds. If a publish remains pending
longer than this value, the transport emits a warning and `send()` returns
without throwing into the host application. The timeout is implemented with
promises and timers; it does not block the event loop.

The constructor does not perform broad runtime validation of these options.

## Published Message

The message body is:

```ts
Buffer.from(JSON.stringify(event), 'utf8');
```

The body preserves the canonical nested `AuditEvent` shape and its camelCase
property names. The transport does not flatten the event and does not transform
the JSON body to snake_case.

Only the routing key is derived from `event.eventType` and converted from
camelCase to snake_case:

| Event field                        | Routing key      | Exchange       |
| ---------------------------------- | ---------------- | -------------- |
| `event.eventType: "business"`      | `business`       | `audit.events` |
| `event.eventType: "security"`      | `security`       | `audit.events` |
| `event.eventType: "securityAlert"` | `security_alert` | `audit.events` |

The current canonical event types are simple words such as `business`,
`security`, and `system`, but the conversion is generic.

## Exchange and Topology

Implemented by this package:

- Creates an `amqp-connection-manager` connection manager.
- Creates a channel wrapper.
- Declares the configured exchange during channel setup.
- Uses exchange type `topic`.
- Marks the exchange as durable.
- Publishes audit events to that exchange.

Not implemented by this package:

- `audit.events.q`
- retry queues
- dead-letter exchanges
- dead-letter queues
- consumer bindings
- prefetch configuration
- Worker process
- TimescaleDB persistence
- SQL tables

Those pieces belong to the future Worker and infrastructure layer. This package
only publishes events to the exchange boundary.

## Connection and Publish Behavior

`amqp-connection-manager` connects and reconnects in the background. The
transport does not require a successful broker connection during construction.

The transport subscribes to:

- `connectFailed`, emitted with `{ err, url }`
- `disconnect`, emitted with `{ err }`

Each connection event received from the dependency produces one warning. During a
long outage, reconnection attempts may produce repeated warnings. This package
does not add warning deduplication, debounce, or rate limiting.

`send(event)` serializes the event and calls the channel wrapper's `publish()`.
A successful publish resolves normally. Synchronous publish errors, rejected
publish promises, and channel-wrapper timeout rejections are converted to
warnings. A publish that stays pending beyond `publishTimeoutMs` also produces a
warning and returns.

The transport does not promise exactly-once delivery, at-least-once delivery,
local durable buffering, application-level retry, global backpressure, or
database persistence.

## Warnings

Warnings use `process.emitWarning()` and this exact prefix:

```text
[mapa-audit-transport-rabbitmq]
```

Warning categories emitted by this package:

- `rabbitmq connection failed: ...`
- `rabbitmq disconnected: ...`
- `rabbitmq transport publish failed: ...`
- `rabbitmq transport publish timed out after <ms>ms`

You can observe them through Node's standard warning event:

```ts
process.on('warning', (warning) => {
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
```

Warnings are informational and do not throw into normal host application flow.
Each expired publish can emit its own timeout warning.

## Credential Safety

Connection failure warnings may include a sanitized connection URL when the
dependency provides one. Sanitization affects only the warning text. The original
configuration passed to RabbitMQ is not modified.

For string AMQP and AMQPS URLs, the warning representation keeps the protocol,
host, port, and vhost path, and removes username, password, query string, and
hash:

```text
amqp://rabbitmq:5672/audit
```

Objects with a string `url` property are sanitized through the same URL parser.
Connection option objects compatible with amqplib are reconstructed only from
safe fields such as protocol, hostname, optional port, and optional vhost.
Username, password, credentials, TLS material, and other connection settings are
not included in warnings.

Malformed URLs, unsupported protocols, unsafe hostnames, and unsupported object
shapes are replaced with:

```text
[invalid connection URL redacted]
```

The transport preserves `event.err` details through the package warning helper,
but it does not include complete connection objects, connection options,
certificates, or TLS configuration in warning text. It cannot guarantee that
every message produced internally by external dependencies is sanitized.

## Graceful Shutdown

`RabbitMQTransport.close()`:

- Removes the `connectFailed` and `disconnect` listeners owned by the transport.
- Closes the channel wrapper.
- Closes the connection manager.

When used through the SDK, `audit.shutdown()` or `shutdownGlobalAudit()` calls
`close()` on transports that provide it:

```ts
process.on('SIGTERM', () => {
  void shutdownGlobalAudit()
    .catch((error: unknown) => {
      process.stderr.write(`audit shutdown failed: ${String(error)}\n`);
    })
    .finally(() => {
      process.exit(0);
    });
});
```

`close()` can reject if the underlying dependency fails during shutdown.
`amqp-connection-manager` does not expose a separate public drain hook for
in-flight publishes beyond `ChannelWrapper.close()`, and this transport does not
add custom buffering.

## Fire-and-Forget

From the SDK's perspective, `record()` is fire-and-forget and does not block
business logic. `RabbitMQTransport.send()` is asynchronous internally, but the SDK
dispatches transports without awaiting them in the caller's request flow.

`publishTimeoutMs` limits how long this transport waits for each publish attempt.
Use `shutdown()` or `shutdownGlobalAudit()` when the process is stopping and
resources need to be closed.

## Operational Considerations

- Observe process warnings and route them into your service logging pipeline.
- Provide RabbitMQ URLs through environment variables or secret management.
- Choose `publishTimeoutMs` based on expected broker latency and outage behavior.
- Use graceful shutdown so connection resources are closed.
- Ensure external infrastructure declares and binds the queues that should
  consume from the configured exchange.
- Expect repeated warnings during a sustained broker outage or repeated publish
  timeouts.

## Scope and Limitations

This package does not implement:

- consumers
- Worker process
- retry/DLQ topology
- database persistence
- TimescaleDB integration
- query API
- exactly-once delivery
- durable local buffer
- application-level retry

Consumers, Workers, and persistence services can be built separately against the
shared `AuditEvent` contract from `@tnet06/mapa-audit-types`.

## Related Packages

- `@tnet06/mapa-audit-sdk`: builds audit events, captures request context through
  adapters, applies payload safety options, and dispatches events to transports.
- `@tnet06/mapa-audit-types`: shared `AuditEvent` and `Transport` contracts used
  by the SDK, transports, and consumers.

## License

MIT. See [LICENSE](./LICENSE).
