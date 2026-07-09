import {
  createAudit,
  type AuditConfig,
  type AuditInstance,
  type GlobalAuditInfo
} from './audit-instance.js';
import type { RecordInput } from './record.js';

let globalAudit: AuditInstance | undefined;
let hasWarnedMissingConfig = false;

export function initGlobalAudit(config: AuditConfig): void {
  globalAudit = createAudit(config);
}

export function recordGlobal(input: RecordInput): void {
  if (globalAudit === undefined) {
    warnMissingGlobalAuditOnce();
    return;
  }

  globalAudit.record(input);
}

export async function shutdownGlobalAudit(): Promise<void> {
  await globalAudit?.shutdown();
}

export function resetGlobalAudit(): void {
  globalAudit = undefined;
  hasWarnedMissingConfig = false;
}

export function getGlobalAudit(): GlobalAuditInfo | undefined {
  return globalAudit?.getInfo();
}

function warnMissingGlobalAuditOnce(): void {
  if (hasWarnedMissingConfig) {
    return;
  }

  hasWarnedMissingConfig = true;

  try {
    process.emitWarning(
      '[mapa-audit] record() called before initGlobalAudit() - events are being discarded. Call initGlobalAudit() at startup, or use createAudit() for an explicit instance.'
    );
  } catch (error: unknown) {
    void error;
  }
}
