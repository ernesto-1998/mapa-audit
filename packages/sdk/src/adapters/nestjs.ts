import { Injectable, type NestMiddleware } from '@nestjs/common';
import { contextStore } from '../core/storage.js';
import {
  buildHttpRequestContext,
  nonEmptyString,
  type ExtractActor
} from './http-context.js';

type HeaderMap = Readonly<Record<string, unknown>>;

interface NestAuditRequest {
  method: string;
  url: string;
  originalUrl?: string;
  headers?: HeaderMap;
  ip?: string;
  user?: {
    id?: unknown;
    role?: unknown;
  };
}

/** Options for the NestJS request context middleware. */
export interface NestAuditMiddlewareOptions {
  /**
   * Header used to reuse an existing correlation id.
   *
   * If the header is absent or empty, the adapter generates a UUID.
   *
   * @default "x-correlation-id"
   */
  correlationIdHeader?: string;
  /**
   * Header used to capture the causation id when present.
   *
   * @default "x-causation-id"
   */
  causationIdHeader?: string;
  /**
   * Replaces the default actor extraction logic.
   *
   * By default, the adapter reads `req.user?.id` and `req.user?.role`; when
   * either exists, it sets actor `type` to `user`. A custom extractor is used as
   * the complete actor source and is not merged with the default.
   */
  extractActor?: ExtractActor<NestAuditRequest>;
}

/**
 * NestJS middleware that captures request context for later `record()` calls.
 *
 * The middleware uses only the request shape common to Nest's HTTP adapters, so
 * it works with both platform-express and platform-fastify.
 */
@Injectable()
export class AuditContextMiddleware implements NestMiddleware {
  readonly #options: NestAuditMiddlewareOptions;

  constructor(options: NestAuditMiddlewareOptions = {}) {
    this.#options = options;
  }

  use(req: NestAuditRequest, _res: unknown, next: () => void): void {
    const endpoint = nonEmptyString(req.originalUrl) ?? req.url;
    const context = buildHttpRequestContext<NestAuditRequest>({
      request: req,
      options: this.#options,
      defaultActorSource: req,
      readHeader: (name) => req.headers?.[name.toLowerCase()],
      httpMethod: req.method,
      endpoint,
      ...(req.ip === undefined ? {} : { ipAddress: req.ip })
    });

    contextStore.run(context, next);
  }
}
