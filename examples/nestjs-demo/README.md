# NestJS Demo

Minimal NestJS app that uses the real `@tnet06/mapa-audit-sdk` workspace package.
It verifies `AuditContextMiddleware` in a real Nest app and demonstrates that the
same audit code works with either Nest HTTP engine: Express or Fastify.

## Install, Build, Run

From the repository root:

```sh
npm install
npm run build
npm run start -w @tnet06/mapa-audit-nestjs-demo
```

The server listens on `HOST`/`PORT`, defaulting to `127.0.0.1:3001`.

## HTTP Engine

`NEST_PLATFORM` selects the underlying Nest HTTP adapter:

```sh
NEST_PLATFORM=express npm run start -w @tnet06/mapa-audit-nestjs-demo
NEST_PLATFORM=fastify npm run start -w @tnet06/mapa-audit-nestjs-demo
```

Run the same endpoint calls with both values. The emitted audit events are
equivalent because controllers and `record()` calls do not change; only the Nest
HTTP engine underneath changes.

## Transport Selection

`AUDIT_TRANSPORT` controls the transport:

```sh
AUDIT_TRANSPORT=console npm run start -w @tnet06/mapa-audit-nestjs-demo
AUDIT_TRANSPORT=file-jsonl npm run start -w @tnet06/mapa-audit-nestjs-demo
AUDIT_TRANSPORT=file-csv npm run start -w @tnet06/mapa-audit-nestjs-demo
AUDIT_TRANSPORT=file-text npm run start -w @tnet06/mapa-audit-nestjs-demo
```

File transports write inside this directory:

- `audit-output.jsonl`
- `audit-output.csv`
- `audit-output.txt`

## Endpoints

```sh
curl http://localhost:3001/health
```

Records a `system` event without an authenticated actor.

```sh
curl http://localhost:3001/users/user-1
```

Records `business/user.viewed` with the route parameter as the entity id. The demo
does not attach a user to this route, so the emitted event has no actor.

```sh
curl -X POST http://localhost:3001/users \
  -H 'content-type: application/json' \
  -d '{"id":"user-2","name":"Grace Hopper"}'
```

Records `business/user.created`. The demo middleware sets `req.user` before
`AuditContextMiddleware`, so the emitted event includes actor context
automatically.

```sh
curl -X POST http://localhost:3001/payments \
  -H 'content-type: application/json' \
  -d '{"amount":42,"creditCard":"4111111111111111","card":{"number":"4111111111111111","cvv":"123"},"user":{"id":"user-2","ssn":"123-45-6789"}}'
```

Records `business/payment.created` with the request body as payload. Look for
`creditCard`, `user.ssn`, and `card.cvv` as `"***"` in the audit output.

```sh
curl http://localhost:3001/reports/report-1
```

Records `business/report.generated` with a deliberately large payload. The demo
sets `maxPayloadSize` to `900`, so the emitted payload is replaced with a
`truncated` marker.
