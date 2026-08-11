import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  return {
    ...actual,
    appendFile: vi.fn(actual.appendFile),
    mkdir: vi.fn(actual.mkdir)
  };
});

import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '@tnet06/mapa-audit-types';
import { AUDIT_EVENT_CSV_COLUMNS } from '../../src/core/flatten.js';
import { FileTransport } from '../../src/transports/file.js';

const tempDirs: string[] = [];

const fullEvent: AuditEvent = {
  id: 'event-1',
  correlationId: 'correlation-1',
  causationId: 'causation-1',
  eventType: 'business',
  eventName: 'recipe.updated',
  severity: 'info',
  outcome: 'success',
  occurredAt: '2026-07-05T00:00:00.000Z',
  payloadSchemaVersion: 1,
  service: {
    name: 'recipes-api',
    version: '1.2.3',
    environment: 'development',
    instanceId: 'instance-1'
  },
  request: {
    httpMethod: 'PATCH',
    endpoint: '/recipes/recipe-1',
    routePattern: '/recipes/:id',
    ipAddress: '127.0.0.1',
    userAgent: 'vitest'
  },
  actor: {
    type: 'user',
    userId: 'user-1',
    userRole: 'admin',
    tenantId: 'tenant-1'
  },
  entity: {
    type: 'recipe',
    id: 'recipe-1'
  },
  payload: {
    changedFields: ['title']
  }
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.appendFile).mockClear();
  vi.mocked(fs.mkdir).mockClear();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe('FileTransport', () => {
  it('appends nested JSON lines by default', async () => {
    const filePath = await createTempFilePath('events.jsonl');
    const transport = new FileTransport({ path: filePath });
    const secondEvent: AuditEvent = {
      ...fullEvent,
      id: 'event-2',
      eventName: 'recipe.deleted'
    };

    await transport.send(fullEvent);
    await transport.send(secondEvent);

    const lines = (await readFile(filePath, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual(fullEvent);
    expect(JSON.parse(lines[1] ?? '')).toEqual(secondEvent);
  });

  it('creates the destination directory only once for repeated sends', async () => {
    const filePath = await createTempFilePath('events.jsonl');
    const transport = new FileTransport({ path: filePath });

    await transport.send(fullEvent);
    await transport.send({ ...fullEvent, id: 'event-2' });
    await transport.send({ ...fullEvent, id: 'event-3' });

    expect(fs.mkdir).toHaveBeenCalledTimes(1);
  });

  it('writes the canonical CSV header once for a new file', async () => {
    const filePath = await createTempFilePath('events.csv');
    const firstTransport = new FileTransport({ path: filePath, format: 'csv' });
    const secondTransport = new FileTransport({
      path: filePath,
      format: 'csv'
    });

    await firstTransport.send(fullEvent);
    await secondTransport.send({ ...fullEvent, id: 'event-2' });

    const rows = parseCsv(await readFile(filePath, 'utf8'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([...AUDIT_EVENT_CSV_COLUMNS]);
    expect(rows[1]?.[0]).toBe('event-1');
    expect(rows[2]?.[0]).toBe('event-2');
  });

  it('writes one CSV header for concurrent sends in the same instance', async () => {
    const filePath = await createTempFilePath('concurrent.csv');
    const transport = new FileTransport({ path: filePath, format: 'csv' });

    await Promise.all([
      transport.send(fullEvent),
      transport.send({ ...fullEvent, id: 'event-2' }),
      transport.send({ ...fullEvent, id: 'event-3' })
    ]);

    const rows = parseCsv(await readFile(filePath, 'utf8'));
    const headerCount = rows.filter((row) =>
      arraysEqual(row, [...AUDIT_EVENT_CSV_COLUMNS])
    ).length;

    expect(rows).toHaveLength(4);
    expect(headerCount).toBe(1);
    expect(rows[1]?.[0]).toBe('event-1');
    expect(rows[2]?.[0]).toBe('event-2');
    expect(rows[3]?.[0]).toBe('event-3');
  });

  it('leaves CSV cells empty for absent optional fields', async () => {
    const filePath = await createTempFilePath('partial.csv');
    const transport = new FileTransport({ path: filePath, format: 'csv' });
    const partialEvent: AuditEvent = {
      id: 'event-1',
      eventType: 'system',
      eventName: 'job.completed',
      severity: 'info',
      occurredAt: '2026-07-05T00:00:00.000Z',
      service: {
        name: 'jobs-api',
        environment: 'production'
      }
    };

    await transport.send(partialEvent);

    const [header, row] = parseCsv(await readFile(filePath, 'utf8'));
    expect(header).toEqual([...AUDIT_EVENT_CSV_COLUMNS]);
    expect(row).toHaveLength(AUDIT_EVENT_CSV_COLUMNS.length);
    expect(cell(header, row, 'id')).toBe('event-1');
    expect(cell(header, row, 'service_name')).toBe('jobs-api');
    expect(cell(header, row, 'request_httpMethod')).toBe('');
    expect(cell(header, row, 'actor_userId')).toBe('');
    expect(cell(header, row, 'payload')).toBe('');
  });

  it('neutralizes formula injection in CSV cells', async () => {
    const filePath = await createTempFilePath('formula.csv');
    const transport = new FileTransport({ path: filePath, format: 'csv' });
    const event: AuditEvent = {
      ...fullEvent,
      correlationId: '=1+1'
    };

    await transport.send(event);

    const content = await readFile(filePath, 'utf8');
    const [header, row] = parseCsv(content);

    expect(cell(header, row, 'correlationId')).toBe("'=1+1");
    expect(content).not.toContain(',=1+1,');
    expect(row).toHaveLength(AUDIT_EVENT_CSV_COLUMNS.length);
  });

  it.each([
    '=1+1',
    '+SUM(1,1)',
    '-1+2',
    '@SUM(1,1)',
    '\t=1+1',
    '\r=1+1',
    '\n=1+1'
  ])(
    'neutralizes CSV formula prefix for values starting with %j',
    async (dangerousValue) => {
      const filePath = await createTempFilePath('formula-prefix.csv');
      const transport = new FileTransport({ path: filePath, format: 'csv' });
      const event: AuditEvent = {
        ...fullEvent,
        correlationId: dangerousValue
      };

      await transport.send(event);

      const [header, row] = parseCsv(await readFile(filePath, 'utf8'));

      expect(cell(header, row, 'correlationId')).toBe(`'${dangerousValue}`);
      expect(cell(header, row, 'correlationId')?.startsWith("'")).toBe(true);
      expect(row).toHaveLength(AUDIT_EVENT_CSV_COLUMNS.length);
    }
  );

  it('neutralizes formulas while preserving structural CSV escaping', async () => {
    const filePath = await createTempFilePath('formula-escaped.csv');
    const transport = new FileTransport({ path: filePath, format: 'csv' });
    const event: AuditEvent = {
      ...fullEvent,
      eventName: '=HYPERLINK("https://example.invalid","open")'
    };

    await transport.send(event);

    const content = await readFile(filePath, 'utf8');
    const [header, row] = parseCsv(content);

    expect(content).toContain(
      '"\'=HYPERLINK(""https://example.invalid"",""open"")"'
    );
    expect(cell(header, row, 'eventName')).toBe(
      '\'=HYPERLINK("https://example.invalid","open")'
    );
    expect(row).toHaveLength(AUDIT_EVENT_CSV_COLUMNS.length);
  });

  it('keeps safe CSV values unchanged while preserving structural escaping', async () => {
    const filePath = await createTempFilePath('safe-values.csv');
    const transport = new FileTransport({ path: filePath, format: 'csv' });
    const event: AuditEvent = {
      ...fullEvent,
      correlationId: 'order-1',
      eventName: 'user@example.com',
      actor: {
        ...fullEvent.actor,
        userId: 'value+suffix',
        userRole: 'normal, "quoted" role'
      }
    };

    await transport.send(event);

    const content = await readFile(filePath, 'utf8');
    const [header, row] = parseCsv(content);

    expect(cell(header, row, 'correlationId')).toBe('order-1');
    expect(cell(header, row, 'eventName')).toBe('user@example.com');
    expect(cell(header, row, 'actor_userId')).toBe('value+suffix');
    expect(cell(header, row, 'actor_userRole')).toBe('normal, "quoted" role');
    expect(content).toContain('"normal, ""quoted"" role"');
    expect(row).toHaveLength(AUDIT_EVENT_CSV_COLUMNS.length);
  });

  it('escapes CSV values containing commas, quotes, or newlines', async () => {
    const filePath = await createTempFilePath('escaped.csv');
    const transport = new FileTransport({ path: filePath, format: 'csv' });
    const event: AuditEvent = {
      ...fullEvent,
      eventName: 'recipe, "updated"\nagain',
      payload: {
        message: 'comma, quote " and\nnewline'
      }
    };

    await transport.send(event);

    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('"recipe, ""updated""\nagain"');
    expect(content).toContain(
      '"{""message"":""comma, quote \\"" and\\nnewline""}"'
    );

    const [, row] = parseCsv(content);
    expect(cell([...AUDIT_EVENT_CSV_COLUMNS], row, 'eventName')).toBe(
      'recipe, "updated"\nagain'
    );
    expect(cell([...AUDIT_EVENT_CSV_COLUMNS], row, 'payload')).toBe(
      JSON.stringify({ message: 'comma, quote " and\nnewline' })
    );
  });

  it('appends a human-readable text line', async () => {
    const filePath = await createTempFilePath('events.txt');
    const transport = new FileTransport({ path: filePath, format: 'text' });

    await transport.send(fullEvent);

    await expect(readFile(filePath, 'utf8')).resolves.toBe(
      '2026-07-05T00:00:00.000Z [business/info] recipe.updated correlationId=correlation-1 outcome=success\n'
    );
  });

  it('emits a warning and resolves send when a write fails', async () => {
    const filePath = await createTempFilePath('events.jsonl');
    const transport = new FileTransport({ path: filePath });
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => true);

    vi.mocked(fs.appendFile).mockRejectedValueOnce(new Error('disk full'));

    await expect(transport.send(fullEvent)).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      '[mapa-audit] file transport write failed: disk full'
    );
  });
});

async function createTempFilePath(fileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mapa-audit-'));
  tempDirs.push(dir);

  return join(dir, fileName);
}

function cell(
  header: readonly string[] | undefined,
  row: readonly string[] | undefined,
  column: string
): string | undefined {
  return row?.[header?.indexOf(column) ?? -1];
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cellValue = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const nextChar = content[index + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        cellValue += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cellValue += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cellValue);
      cellValue = '';
    } else if (char === '\n') {
      row.push(cellValue);
      rows.push(row);
      row = [];
      cellValue = '';
    } else if (char !== '\r') {
      cellValue += char;
    }
  }

  if (cellValue.length > 0 || row.length > 0) {
    row.push(cellValue);
    rows.push(row);
  }

  return rows;
}
