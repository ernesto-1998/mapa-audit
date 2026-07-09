import type { AuditEvent } from '@tnet06/mapa-audit-types';

export interface Transport {
  send(event: AuditEvent): void | Promise<void>;
  close?(): Promise<void>;
}
