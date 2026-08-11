import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import {
  AUDIT_EVENT_CSV_COLUMNS,
  flatten,
  type AuditEventCsvColumn
} from '../core/flatten.js';
import type { Transport } from '../core/transport.js';
import { isStringMember } from '../core/validation.js';
import { emitAuditWarning, errorMessage } from '../core/warnings.js';

const fileTransportFormats = ['jsonl', 'csv', 'text'] as const;
type FileTransportFormat = (typeof fileTransportFormats)[number];
const defaultFileTransportFormat: FileTransportFormat = 'jsonl';
const invalidFileTransportFormatMessage =
  '[mapa-audit] invalid FileTransport format; expected one of: jsonl, csv, text';

/** Options for `FileTransport`. */
export interface FileTransportOptions {
  /** Destination file path. Parent directories are created automatically. */
  path: string;
  /**
   * File output format.
   *
   * - `jsonl`: default. Writes one nested JSON event per line.
   * - `csv`: writes fixed canonical columns, flattening known event groups.
   * - `text`: writes one compact human-readable line per event.
   *
   * @default "jsonl"
   */
  format?: FileTransportFormat;
}

/**
 * Transport that appends audit events to a local file.
 *
 * `jsonl` preserves the nested event. `csv` uses the shared flatten helper and a
 * fixed header. `text` includes occurredAt, event type, severity, event name,
 * correlationId, and outcome when available.
 *
 * CSV header coordination is safe within one `FileTransport` instance/process.
 * Multiple processes writing to the same file concurrently are not coordinated;
 * use process-level file locking outside the SDK if that is required.
 */
export class FileTransport implements Transport {
  readonly #path: string;
  readonly #format: FileTransportFormat;
  #pendingWrite: Promise<void> = Promise.resolve();
  #directoryReady: Promise<void> | undefined;
  #headerWritten = false;

  /**
   * Creates a file transport using the selected append-only output format.
   *
   * @throws Error when `format` is not one of `jsonl`, `csv`, or `text`.
   */
  constructor(options: FileTransportOptions) {
    const format: unknown =
      options.format === undefined
        ? defaultFileTransportFormat
        : options.format;

    if (!isStringMember(format, fileTransportFormats)) {
      throw new Error(invalidFileTransportFormatMessage);
    }

    this.#path = options.path;
    this.#format = format;
  }

  /**
   * Queues one append operation.
   *
   * Writes are serialized per instance. Failures are emitted as mapa-audit
   * warnings and are not thrown into host application code.
   */
  send(event: AuditEvent): Promise<void> {
    const write = this.#pendingWrite.then(() => this.#writeEvent(event));
    const handledWrite = write.catch((error: unknown) => {
      emitWriteWarning(error);
    });

    this.#pendingWrite = handledWrite;

    return handledWrite;
  }

  /** Waits until all queued file writes have completed. */
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

  const neutralizedValue = neutralizeSpreadsheetFormula(value);

  if (/[",\n\r]/u.test(neutralizedValue)) {
    return `"${neutralizedValue.replaceAll('"', '""')}"`;
  }

  return neutralizedValue;
}

function neutralizeSpreadsheetFormula(value: string): string {
  if (/^[=+\-@\t\r\n]/u.test(value)) {
    return `'${value}`;
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
  emitAuditWarning(`file transport write failed: ${errorMessage(error)}`);
}

export type { AuditEventCsvColumn };
