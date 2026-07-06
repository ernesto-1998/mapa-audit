import type { AuditEvent } from '@tnet06/mapa-audit-types';
import type { Transport } from '../core/transport.js';

export class ConsoleTransport implements Transport {
  send(event: AuditEvent): void {
    const line = `${JSON.stringify(event)}\n`;

    if (event.severity === 'error' || event.severity === 'critical') {
      process.stderr.write(line);
      return;
    }

    process.stdout.write(line);
  }
}
