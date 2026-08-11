import type { NextFunction, Request, RequestHandler } from 'express';
import { contextStore, type RequestContext } from '../core/storage.js';
import {
  buildHttpRequestContext,
  nonEmptyString,
  type ExtractActor
} from './http-context.js';

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
  extractActor?: ExtractActor<Request>;
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
    const context = buildHttpRequestContext<Request>({
      request: req,
      options,
      defaultActorSource: request,
      readHeader: (name) => request.get(name),
      httpMethod: request.method,
      endpoint: request.originalUrl,
      ...(request.ip === undefined ? {} : { ipAddress: request.ip })
    });

    defineDeferredRoutePattern(context, request);

    contextStore.run(context, () => next());
  };
}

function defineDeferredRoutePattern(
  context: RequestContext,
  request: RequestWithOptionalUser
): void {
  const baseRequest = context.request;

  if (baseRequest === undefined) {
    return;
  }

  Object.defineProperty(context, 'request', {
    configurable: true,
    enumerable: true,
    get(): NonNullable<RequestContext['request']> {
      const routePattern = nonEmptyString(request.route?.path);

      return {
        ...baseRequest,
        ...(routePattern === undefined ? {} : { routePattern })
      };
    }
  });
}
