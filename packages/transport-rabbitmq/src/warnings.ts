const warningPrefix = '[mapa-audit-transport-rabbitmq]';

export function emitAuditWarning(message: string): void {
  try {
    process.emitWarning(`${warningPrefix} ${message}`);
  } catch {
    // Warning emission must never interfere with the host application.
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
