import {
  Module,
  type MiddlewareConsumer,
  type NestModule
} from '@nestjs/common';
import { AuditContextMiddleware } from '@tnet06/mapa-audit-sdk/nestjs';
import { DemoController } from './demo.controller.js';

type DemoRequest = {
  url?: string;
  originalUrl?: string;
  user?: {
    id: string;
    role: string;
  };
};

type DemoNext = () => void;

const auditContextMiddleware = new AuditContextMiddleware();

@Module({
  controllers: [DemoController]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        attachDemoUser,
        auditContextMiddleware.use.bind(auditContextMiddleware)
      )
      .forRoutes('*');
  }
}

function attachDemoUser(req: DemoRequest, _res: unknown, next: DemoNext): void {
  const path = req.originalUrl ?? req.url ?? '';

  if (path !== '/health' && !path.startsWith('/users/')) {
    req.user = {
      id: 'demo-user-1',
      role: 'demo-admin'
    };
  }

  next();
}
