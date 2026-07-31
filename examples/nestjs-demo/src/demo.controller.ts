import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { record } from '@tnet06/mapa-audit-sdk';

@Controller()
export class DemoController {
  @Get('users/:id')
  viewUser(@Param('id') id: string): { user: DemoUser } {
    const user = {
      id,
      name: 'Ada Lovelace',
      email: 'ada@example.test'
    };

    record({
      eventType: 'business',
      eventName: 'user.viewed',
      outcome: 'success',
      entity: {
        type: 'user',
        id
      },
      payload: {
        viewedFrom: 'nestjs-demo'
      }
    });

    return { user };
  }

  @Post('users')
  createUser(@Body() body: unknown): { id: string; status: string } {
    const payload = payloadFromBody(body);
    const userId = stringField(payload.id) ?? 'created-user-1';

    record({
      eventType: 'business',
      eventName: 'user.created',
      outcome: 'success',
      entity: {
        type: 'user',
        id: userId
      },
      payload
    });

    return {
      id: userId,
      status: 'created'
    };
  }

  @Post('payments')
  createPayment(@Body() body: unknown): { id: string; status: string } {
    const payload = payloadFromBody(body);

    record({
      eventType: 'business',
      eventName: 'payment.created',
      severity: 'info',
      outcome: 'success',
      entity: {
        type: 'payment',
        id: 'payment-demo-1'
      },
      payload
    });

    return {
      id: 'payment-demo-1',
      status: 'accepted'
    };
  }

  @Get('reports/:id')
  getReport(@Param('id') id: string): {
    id: string;
    status: string;
    auditPayload: string;
  } {
    record({
      eventType: 'business',
      eventName: 'report.generated',
      outcome: 'success',
      entity: {
        type: 'report',
        id
      },
      payload: buildLargeReportPayload(id)
    });

    return {
      id,
      status: 'generated',
      auditPayload: 'truncated'
    };
  }

  @Get('health')
  @HttpCode(200)
  health(): { status: string } {
    record({
      eventType: 'system',
      eventName: 'health.checked',
      severity: 'debug',
      outcome: 'success',
      payload: {
        status: 'ok'
      }
    });

    return { status: 'ok' };
  }
}

interface DemoUser {
  id: string;
  name: string;
  email: string;
}

function payloadFromBody(body: unknown): Record<string, unknown> {
  if (isRecord(body)) {
    return body;
  }

  return {
    value: body
  };
}

function buildLargeReportPayload(reportId: string): Record<string, unknown> {
  return {
    reportId,
    rows: Array.from({ length: 80 }, (_, index) => ({
      index,
      metric: `metric-${index}`,
      description:
        'Repeated demo report content used to exceed the configured audit payload limit.'
    }))
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
