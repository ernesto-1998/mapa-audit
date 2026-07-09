import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import {
  AUDIT_EVENT_CSV_COLUMNS,
  flatten,
  type AuditEventCsvColumn
} from '../core/flatten.js';
import type { Transport } from '../core/transport.js';

export interface FileTransportOptions {
  path: string;
  format?: 'jsonl' | 'csv' | 'text';
}

export class FileTransport implements Transport {
  readonly #path: string;
  readonly #format: NonNullable<FileTransportOptions['format']>;
  #pendingWrite: Promise<void> = Promise.resolve();
  #directoryReady: Promise<void> | undefined;
  #headerWritten = false;

  constructor(options: FileTransportOptions) {
    this.#path = options.path;
    this.#format = options.format ?? 'jsonl';
  }

  send(event: AuditEvent): Promise<void> {
    const write = this.#pendingWrite.then(() => this.#writeEvent(event));
    const handledWrite = write.catch((error: unknown) => {
      emitWriteWarning(error);
    });

    this.#pendingWrite = handledWrite;

    return handledWrite;
  }

  async close(): Promise<void> {
    await this.#pendingWrite;
  }

  async #writeEvent(event: AuditEvent): Promise<void> {
    await this.#ensureDirectory();

    switch (this.#format) {
      case 'jsonl':
        await fs.appendFile(this.#path, `${JSON.stringify(event)}\n`, 'utf8');
        return;
      case 'csv':
        await this.#writeCsv(event);
        return;
      case 'text':
        await fs.appendFile(this.#path, `${formatTextLine(event)}\n`, 'utf8');
        return;
    }
  }

  async #writeCsv(event: AuditEvent): Promise<void> {
    const needsHeader = await this.#needsCsvHeader();
    const flatEvent = flatten(event);
    const row = AUDIT_EVENT_CSV_COLUMNS.map((column) =>
      escapeCsvCell(flatEvent[column])
    ).join(',');
    const content = `${needsHeader ? `${AUDIT_EVENT_CSV_COLUMNS.join(',')}\n` : ''}${row}\n`;

    await fs.appendFile(this.#path, content, 'utf8');
  }

  async #ensureDirectory(): Promise<void> {
    this.#directoryReady ??= fs
      .mkdir(dirname(this.#path), { recursive: true })
      .then(() => undefined);

    await this.#directoryReady;
  }

  async #needsCsvHeader(): Promise<boolean> {
    if (this.#headerWritten) {
      return false;
    }

    this.#headerWritten = true;

    return isMissingOrEmpty(this.#path);
  }
}

function escapeCsvCell(value: string | undefined): string {
  if (value === undefined) {
    return '';
  }

  if (/[",\n\r]/u.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return value;
}

function formatTextLine(event: AuditEvent): string {
  const fields = [
    `${event.occurredAt} [${event.eventType}/${event.severity}]`,
    event.eventName,
    event.correlationId === undefined
      ? undefined
      : `correlationId=${event.correlationId}`,
    event.outcome === undefined ? undefined : `outcome=${event.outcome}`
  ];

  return fields.filter((field) => field !== undefined).join(' ');
}

async function isMissingOrEmpty(path: string): Promise<boolean> {
  try {
    const fileStat = await fs.stat(path);
    return fileStat.size === 0;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return true;
    }

    throw error;
  }
}

function isNodeErrorWithCode(
  error: unknown,
  code: string
): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function emitWriteWarning(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  try {
    process.emitWarning(`[mapa-audit] file transport write failed: ${message}`);
  } catch (warningError: unknown) {
    void warningError;
  }
}

export type { AuditEventCsvColumn };
