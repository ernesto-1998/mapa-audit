export function emitAuditWarning(message: string): void {
  try {
    process.emitWarning(`[mapa-audit] ${message}`);
  } catch (error: unknown) {
    void error;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
