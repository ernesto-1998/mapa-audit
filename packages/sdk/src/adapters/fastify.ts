import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction
} from 'fastify';
import { contextStore } from '../core/storage.js';
import {
  buildHttpRequestContext,
  nonEmptyString,
  type ExtractActor
} from './http-context.js';

type FastifyAuditRequest = FastifyRequest & {
  routerPath?: unknown;
  user?: {
    id?: unknown;
    role?: unknown;
  };
};

/** Options for the Fastify request context adapter. */
export interface FastifyAdapterOptions {
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
   * By default, the adapter reads `request.user?.id` and
   * `request.user?.role`; when either exists, it sets actor `type` to `user`.
   * A custom extractor is used as the complete actor source and is not merged
   * with the default.
   */
  extractActor?: ExtractActor<FastifyAuditRequest>;
}

/**
 * Fastify plugin that captures request context for later `record()` calls.
 *
 * The request hook deliberately uses Fastify's callback-style `done`
 * continuation so the route handler is created inside `AsyncLocalStorage`.
 */
const fastifyAdapterPlugin: FastifyPluginCallback<FastifyAdapterOptions> = (
  fastify,
  options,
  done
): void => {
  fastify.addHook(
    'onRequest',
    (
      request: FastifyRequest,
      _reply: FastifyReply,
      hookDone: HookHandlerDoneFunction
    ): void => {
      const auditRequest = request as FastifyAuditRequest;
      const routePattern =
        nonEmptyString(auditRequest.routeOptions?.url) ??
        nonEmptyString(auditRequest.routerPath);
      const context = buildHttpRequestContext<FastifyAuditRequest>({
        request: auditRequest,
        options,
        defaultActorSource: auditRequest,
        readHeader: (name) => auditRequest.headers[name.toLowerCase()],
        httpMethod: auditRequest.method,
        endpoint: auditRequest.url,
        routePattern,
        ipAddress: auditRequest.ip
      });

      contextStore.run(context, hookDone);
    }
  );

  done();
};

Object.defineProperty(fastifyAdapterPlugin, Symbol.for('skip-override'), {
  value: true
});
Object.defineProperty(
  fastifyAdapterPlugin,
  Symbol.for('fastify.display-name'),
  {
    value: '@tnet06/mapa-audit-fastify-adapter'
  }
);

export const fastifyAdapter: FastifyPluginCallback<FastifyAdapterOptions> =
  fastifyAdapterPlugin;
