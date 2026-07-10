import type { AuditEvent } from '@tnet06/mapa-audit-types';
import type { Transport } from '../core/transport.js';

/**
 * Transport that emits each audit event as one nested JSON line.
 *
 * Events with severity `error` or `critical` are written to `process.stderr`.
 * All other severities are written to `process.stdout`. This transport does not
 * flatten the event.
 */
export class ConsoleTransport implements Transport {
  /** Serializes and writes one event to stdout or stderr based on severity. */
  send(event: AuditEvent): void {
    const line = `${JSON.stringify(event)}\n`;

    if (event.severity === 'error' || event.severity === 'critical') {
      process.stderr.write(line);
      return;
    }

    process.stdout.write(line);
  }
}
