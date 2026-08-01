import 'reflect-metadata';
import {
  Controller,
  Get,
  Module,
  Injectable,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type MiddlewareConsumer,
  type NestInterceptor,
  type NestModule,
  type INestApplication
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Observable } from 'rxjs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { AuditContextMiddleware } from '../../src/adapters/nestjs.js';
import {
  initGlobalAudit,
  resetGlobalAudit
} from '../../src/core/global-audit.js';
import { record } from '../../src/core/record.js';
import {
  contextStore,
  getContext,
  setActor,
  type RequestContext
} from '../../src/core/storage.js';
import type { Transport } from '../../src/core/transport.js';

interface CapturedContexts {
  middleware: RequestContext | undefined;
  guard: RequestContext | undefined;
  interceptor: RequestContext | undefined;
  controller: RequestContext | undefined;
}

const capturedContexts: CapturedContexts = {
  middleware: undefined,
  guard: undefined,
  interceptor: undefined,
  controller: undefined
};
const capturedEvents: AuditEvent[] = [];

@Injectable()
class LifecycleGuard implements CanActivate {
  canActivate(): boolean {
    capturedContexts.guard = getContext();
    return true;
  }
}

@Injectable()
class JwtActorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<JwtActorRequest>();
    const userId =
      singleHeader(request.headers['x-demo-user-id']) ?? 'jwt-user';
    const userRole = singleHeader(request.headers['x-demo-user-role']);

    setActor({
      type: 'user',
      userId,
      ...(userRole === undefined ? {} : { userRole })
    });

    return true;
  }
}

@Injectable()
class LifecycleInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler
  ): Observable<unknown> {
    capturedContexts.interceptor = getContext();
    return next.handle();
  }
}

@Controller()
class LifecycleController {
  @Get('/lifecycle')
  @UseGuards(LifecycleGuard)
  @UseInterceptors(LifecycleInterceptor)
  lifecycle(): { ok: true } {
    capturedContexts.controller = getContext();
    return { ok: true };
  }

  @Get('/record-actor')
  @UseGuards(JwtActorGuard)
  recordActor(): { ok: true } {
    record({
      eventType: 'business',
      eventName: 'jwt.guard.recorded',
      outcome: 'success',
      entity: {
        type: 'request',
        id: getContext()?.correlationId ?? 'unknown'
      }
    });

    return { ok: true };
  }
}

@Module({
  controllers: [LifecycleController],
  providers: [LifecycleGuard, JwtActorGuard, LifecycleInterceptor]
})
class LifecycleTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    const auditContextMiddleware = new AuditContextMiddleware();

    consumer
      .apply(auditContextMiddleware.use.bind(auditContextMiddleware))
      .forRoutes('*');
  }
}

describe('AuditContextMiddleware NestJS lifecycle integration', () => {
  beforeEach(() => {
    clearCapturedContexts();
    capturedEvents.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetGlobalAudit();
  });

  it('keeps the same AsyncLocalStorage context object through guard, interceptor, and controller', async () => {
    const originalRun = contextStore.run.bind(contextStore);

    vi.spyOn(contextStore, 'run').mockImplementation(
      <R>(store: RequestContext, callback: () => R): R => {
        capturedContexts.middleware = store;
        return originalRun(store, callback);
      }
    );

    const testingModule = await Test.createTestingModule({
      imports: [LifecycleTestModule]
    }).compile();
    const app: INestApplication = testingModule.createNestApplication();

    await app.init();

    try {
      await request(app.getHttpServer())
        .get('/lifecycle')
        .set('x-correlation-id', 'nest-lifecycle-correlation')
        .set('x-causation-id', 'nest-lifecycle-causation')
        .expect(200)
        .expect({ ok: true });

      expect(capturedContexts.middleware).toBeDefined();
      expect(capturedContexts.guard).toBe(capturedContexts.middleware);
      expect(capturedContexts.interceptor).toBe(capturedContexts.middleware);
      expect(capturedContexts.controller).toBe(capturedContexts.middleware);
      expect(capturedContexts.controller).toMatchObject({
        correlationId: 'nest-lifecycle-correlation',
        causationId: 'nest-lifecycle-causation',
        request: {
          httpMethod: 'GET',
          endpoint: '/lifecycle'
        }
      });
    } finally {
      await app.close();
    }
  });

  it('lets a NestJS guard set actor before a controller records an event', async () => {
    initGlobalAudit({
      serviceName: 'nestjs-lifecycle-test',
      environment: 'development',
      transports: [capturingTransport]
    });

    const app = await createLifecycleApp();

    try {
      await request(app.getHttpServer())
        .get('/record-actor')
        .set('x-demo-user-id', 'jwt-user-1')
        .set('x-demo-user-role', 'admin')
        .expect(200)
        .expect({ ok: true });

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]).toMatchObject({
        eventType: 'business',
        eventName: 'jwt.guard.recorded',
        actor: {
          type: 'user',
          userId: 'jwt-user-1',
          userRole: 'admin'
        }
      });
    } finally {
      await app.close();
    }
  });

  it('keeps setActor isolated between concurrent NestJS requests', async () => {
    initGlobalAudit({
      serviceName: 'nestjs-lifecycle-test',
      environment: 'development',
      transports: [capturingTransport]
    });

    const app = await createLifecycleApp();

    try {
      await Promise.all([
        request(app.getHttpServer())
          .get('/record-actor')
          .set('x-demo-user-id', 'jwt-user-a')
          .set('x-demo-user-role', 'reader')
          .expect(200)
          .expect({ ok: true }),
        request(app.getHttpServer())
          .get('/record-actor')
          .set('x-demo-user-id', 'jwt-user-b')
          .set('x-demo-user-role', 'writer')
          .expect(200)
          .expect({ ok: true })
      ]);

      expect(capturedEvents).toHaveLength(2);

      const eventsByUserId = new Map(
        capturedEvents.map((event) => [event.actor?.userId, event])
      );

      expect(eventsByUserId.get('jwt-user-a')).toMatchObject({
        actor: {
          type: 'user',
          userId: 'jwt-user-a',
          userRole: 'reader'
        }
      });
      expect(eventsByUserId.get('jwt-user-b')).toMatchObject({
        actor: {
          type: 'user',
          userId: 'jwt-user-b',
          userRole: 'writer'
        }
      });
    } finally {
      await app.close();
    }
  });
});

function clearCapturedContexts(): void {
  capturedContexts.middleware = undefined;
  capturedContexts.guard = undefined;
  capturedContexts.interceptor = undefined;
  capturedContexts.controller = undefined;
}

const capturingTransport: Transport = {
  send(event) {
    capturedEvents.push(event);
  }
};

interface JwtActorRequest {
  headers: Record<string, string | string[] | undefined>;
}

async function createLifecycleApp(): Promise<INestApplication> {
  const testingModule = await Test.createTestingModule({
    imports: [LifecycleTestModule]
  }).compile();
  const app = testingModule.createNestApplication();

  await app.init();

  return app;
}

function singleHeader(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
