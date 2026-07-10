import type { AuditEvent } from '@tnet06/mapa-audit-types';

/** Contract implemented by every audit event destination. */
export interface Transport {
  /**
   * Delivers one already-built audit event.
   *
   * Implementations may be synchronous or asynchronous. SDK dispatch contains
   * errors so transport failures do not throw into host application code.
   */
  send(event: AuditEvent): void | Promise<void>;
  /**
   * Optional lifecycle hook for transports with pending work.
   *
   * `AuditInstance.shutdown()` and `shutdownGlobalAudit()` call this to drain
   * buffered writes before process shutdown.
   */
  close?(): Promise<void>;
}
