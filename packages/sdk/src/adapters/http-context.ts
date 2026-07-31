import { randomUUID } from 'node:crypto';
import type { ActorType } from '@tnet06/mapa-audit-types';
import type { RequestContext } from '../core/storage.js';

const authenticatedActorType: ActorType = 'user';

export const defaultCorrelationIdHeader = 'x-correlation-id';
export const defaultCausationIdHeader = 'x-causation-id';

export type ExtractActor<TRequest> = (
  req: TRequest
) => NonNullable<RequestContext['actor']> | undefined;

export interface HttpContextAdapterOptions<TRequest> {
  correlationIdHeader?: string;
  causationIdHeader?: string;
  extractActor?: ExtractActor<TRequest>;
}

export interface DefaultActorSource {
  user?: {
    id?: unknown;
    role?: unknown;
  };
}

interface BuildHttpRequestContextInput<TRequest> {
  request: TRequest;
  options: HttpContextAdapterOptions<TRequest>;
  defaultActorSource: DefaultActorSource;
  readHeader(name: string): unknown;
  httpMethod: string;
  endpoint: string;
  routePattern?: unknown;
  ipAddress?: string;
}

export function buildHttpRequestContext<TRequest>(
  input: BuildHttpRequestContextInput<TRequest>
): RequestContext {
  const headerCorrelationId = nonEmptyString(
    input.readHeader(
      input.options.correlationIdHeader ?? defaultCorrelationIdHeader
    )
  );
  const headerCausationId = nonEmptyString(
    input.readHeader(
      input.options.causationIdHeader ?? defaultCausationIdHeader
    )
  );
  const userAgent = nonEmptyString(input.readHeader('user-agent'));
  const routePattern = nonEmptyString(input.routePattern);
  const actor =
    input.options.extractActor === undefined
      ? getActor(input.defaultActorSource)
      : input.options.extractActor(input.request);

  return {
    correlationId: headerCorrelationId ?? randomUUID(),
    ...(headerCausationId === undefined
      ? {}
      : { causationId: headerCausationId }),
    request: {
      httpMethod: input.httpMethod,
      endpoint: input.endpoint,
      ...(routePattern === undefined ? {} : { routePattern }),
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      ...(userAgent === undefined ? {} : { userAgent })
    },
    ...(actor === undefined ? {} : { actor })
  };
}

export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  return value;
}

function getActor(
  request: DefaultActorSource
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
