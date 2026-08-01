# Fastify Demo

Minimal Fastify app that uses the real `@tnet06/mapa-audit-sdk` workspace
package. It demonstrates automatic request context capture, route pattern
capture, console/file transports, payload masking, and payload truncation.

## Install, Build, Run

From the repository root:

```sh
npm install
npm run build
npm run start -w @tnet06/mapa-audit-fastify-demo
```

The server listens on `HOST`/`PORT`, defaulting to `127.0.0.1:3002`.

## Transport Selection

`AUDIT_TRANSPORT` controls the transport:

```sh
AUDIT_TRANSPORT=console npm run start -w @tnet06/mapa-audit-fastify-demo
AUDIT_TRANSPORT=file-jsonl npm run start -w @tnet06/mapa-audit-fastify-demo
AUDIT_TRANSPORT=file-csv npm run start -w @tnet06/mapa-audit-fastify-demo
AUDIT_TRANSPORT=file-text npm run start -w @tnet06/mapa-audit-fastify-demo
```

File transports write inside this directory:

- `audit-output.jsonl`
- `audit-output.csv`
- `audit-output.txt`

## Endpoints

```sh
curl http://localhost:3002/health
```

Records a `system` event without an authenticated actor.

```sh
curl http://localhost:3002/users/user-1
```

Records `business/user.viewed` with the route parameter as the entity id. The
Fastify adapter captures `request.routePattern` as `/users/:id`, unlike the
NestJS adapter, which does not capture route patterns by design.

```sh
curl -X POST http://localhost:3002/users \
  -H 'content-type: application/json' \
  -d '{"id":"user-2","name":"Grace Hopper"}'
```

Records `business/user.created`. The demo `onRequest` hook sets `request.user`
before `fastifyAdapter`, so the emitted event includes actor context
automatically.

```sh
curl -X POST http://localhost:3002/payments \
  -H 'content-type: application/json' \
  -d '{"amount":42,"creditCard":"4111111111111111","card":{"number":"4111111111111111","cvv":"123"},"user":{"id":"user-2","ssn":"123-45-6789"}}'
```

Records `business/payment.created` with the request body as payload. Look for
`creditCard`, `user.ssn`, and `card.cvv` as `"***"` in the audit output.

```sh
curl http://localhost:3002/reports/report-1
```

Records `business/report.generated` with a deliberately large payload. The demo
sets `maxPayloadSize` to `900`, so the emitted payload is replaced with a
`truncated` marker.
