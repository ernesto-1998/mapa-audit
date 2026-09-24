# @tnet06/mapa-audit-sdk

## 0.2.0

### Minor Changes

- Add `buildEvent()` to the global and per-instance SDK APIs.

  `buildEvent()` constructs and returns a canonical `AuditEvent` without executing
  configured transports. Construction and validation errors are propagated
  synchronously to the caller, and the returned event is an independent snapshot
  that does not share mutable references with the input or the active
  `AsyncLocalStorage` context.

  This release also adds optional `instanceId` support in `AuditConfig`, exposes
  `serviceVersion` and `instanceId` from `getInfo()` and `getGlobalAudit()` when
  configured, and preserves the existing fire-and-forget behavior of `record()`.

## 0.1.0

### Initial release

- Added the shared canonical event contract through `@tnet06/mapa-audit-types`.
- Added global and per-instance audit APIs.
- Added request-scoped context capture with `AsyncLocalStorage`.
- Added Express, Fastify, and NestJS adapters.
- Added console and file transports.
- Added sensitive field masking for payloads.
- Added serialized payload size limits.
- Added transport error isolation and fire-and-forget behavior for `record()`.
