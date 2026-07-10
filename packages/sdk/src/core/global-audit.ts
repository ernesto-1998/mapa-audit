import {
  createAudit,
  type AuditConfig,
  type AuditInstance,
  type GlobalAuditInfo
} from './audit-instance.js';
import type { RecordInput } from './record.js';

let globalAudit: AuditInstance | undefined;
let hasWarnedMissingConfig = false;

/**
 * Initializes the convenience global audit singleton.
 *
 * This creates an internal `AuditInstance` via `createAudit()`. Call it once at
 * application startup before using the global `record()` helper.
 * Use this global path for the simple case: one audit configuration per process,
 * typically a single app/service initialized once at startup.
 *
 * @param config Service metadata, transports, and payload safety options.
 */
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

/**
 * Drains the global audit singleton if it has been initialized.
 *
 * Safe to call even when no global audit instance exists.
 */
export async function shutdownGlobalAudit(): Promise<void> {
  await globalAudit?.shutdown();
}

/**
 * Clears the global singleton and its one-time warning state.
 *
 * Intended for tests or controlled reinitialization in development.
 */
export function resetGlobalAudit(): void {
  globalAudit = undefined;
  hasWarnedMissingConfig = false;
}

/**
 * Returns a read-only inspection view of the global audit singleton.
 *
 * The returned object contains only metadata such as service name, environment,
 * and transport count. It does not expose transports or mutating methods.
 */
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
