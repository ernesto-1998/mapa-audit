import { appendFile, mkdir, stat } from 'node:fs/promises';
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

  constructor(options: FileTransportOptions) {
    this.#path = options.path;
    this.#format = options.format ?? 'jsonl';
  }

  send(event: AuditEvent): Promise<void> {
    const write = this.#pendingWrite.then(() => this.#writeEvent(event));
    this.#pendingWrite = write.catch(() => undefined);

    return write;
  }

  async close(): Promise<void> {
    await this.#pendingWrite;
  }

  async #writeEvent(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });

    switch (this.#format) {
      case 'jsonl':
        await appendFile(this.#path, `${JSON.stringify(event)}\n`, 'utf8');
        return;
      case 'csv':
        await this.#writeCsv(event);
        return;
      case 'text':
        await appendFile(this.#path, `${formatTextLine(event)}\n`, 'utf8');
        return;
    }
  }

  async #writeCsv(event: AuditEvent): Promise<void> {
    const needsHeader = await isMissingOrEmpty(this.#path);
    const flatEvent = flatten(event);
    const row = AUDIT_EVENT_CSV_COLUMNS.map((column) =>
      escapeCsvCell(flatEvent[column])
    ).join(',');
    const content = `${needsHeader ? `${AUDIT_EVENT_CSV_COLUMNS.join(',')}\n` : ''}${row}\n`;

    await appendFile(this.#path, content, 'utf8');
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
    const fileStat = await stat(path);
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

export type { AuditEventCsvColumn };
