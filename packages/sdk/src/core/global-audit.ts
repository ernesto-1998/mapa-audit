import {
  createAudit,
  type AuditConfig,
  type AuditInstance,
  type GlobalAuditInfo
} from './audit-instance.js';
import type { RecordInput } from './record.js';

let globalAudit: AuditInstance | undefined;

export function initGlobalAudit(config: AuditConfig): void {
  globalAudit = createAudit(config);
}

export function recordGlobal(input: RecordInput): void {
  globalAudit?.record(input);
}

export async function shutdownGlobalAudit(): Promise<void> {
  await globalAudit?.shutdown();
}

export function resetGlobalAudit(): void {
  globalAudit = undefined;
}

export function getGlobalAudit(): GlobalAuditInfo | undefined {
  return globalAudit?.getInfo();
}
