import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler } from 'express';
import type { ActorType } from '@tnet06/mapa-audit-types';
import { contextStore, type RequestContext } from '../core/storage.js';

const authenticatedActorType: ActorType = 'user';
const defaultCorrelationIdHeader = 'x-correlation-id';
const defaultCausationIdHeader = 'x-causation-id';

/** Options for the Express request context adapter. */
export interface ExpressAdapterOptions {
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
  extractActor?: (
    req: Request
  ) => NonNullable<RequestContext['actor']> | undefined;
}

type RequestWithOptionalUser = Request & {
  user?: {
    id?: unknown;
    role?: unknown;
  };
  route?: {
    path?: unknown;
  };
};

/**
 * Creates Express middleware that captures request context for later `record()`
 * calls.
 *
 * The adapter only stores context in `AsyncLocalStorage`; it does not emit audit
 * events and does not know about transports.
 *
 * @param options Optional header names and actor extraction hook.
 * @returns Express request handler.
 */
export function expressAdapter(
  options: ExpressAdapterOptions = {}
): RequestHandler {
  return (req: Request, _res, next: NextFunction): void => {
    const request = req as RequestWithOptionalUser;
    const headerCorrelationId = nonEmptyString(
      request.get(options.correlationIdHeader ?? defaultCorrelationIdHeader)
    );
    const headerCausationId = nonEmptyString(
      request.get(options.causationIdHeader ?? defaultCausationIdHeader)
    );
    const userAgent = nonEmptyString(request.get('user-agent'));
    const routePattern = getRoutePattern(request);
    const actor =
      options.extractActor === undefined
        ? getActor(request)
        : options.extractActor(req);

    const context: RequestContext = {
      correlationId: headerCorrelationId ?? randomUUID(),
      ...(headerCausationId === undefined
        ? {}
        : { causationId: headerCausationId }),
      request: {
        httpMethod: request.method,
        endpoint: request.originalUrl,
        ...(routePattern === undefined ? {} : { routePattern }),
        ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
        ...(userAgent === undefined ? {} : { userAgent })
      },
      ...(actor === undefined ? {} : { actor })
    };

    contextStore.run(context, () => next());
  };
}

function getRoutePattern(request: RequestWithOptionalUser): string | undefined {
  return nonEmptyString(request.route?.path);
}

function getActor(
  request: RequestWithOptionalUser
): NonNullable<RequestContext['actor']> | undefined {
  const userId = nonEmptyString(request.user?.id);
  const userRole = nonEmptyString(request.user?.role);

  if (userId === undefined && userRole === undefined) {
    return undefined;
  }

  return {
    type: authenticatedActorType,
    ...(userId === undefined ? {} : { userId }),
    ...(userRole === undefined ? {} : { userRole })
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  return value;
}
