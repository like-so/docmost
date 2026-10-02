import { randomUUID } from 'node:crypto';
import {
  IndexRequest,
  RAG_SCHEMA_VERSION,
  parseIndexRequest,
  serializeIndexRequest,
  toInputRevision,
} from './contracts';

const validRequest = (): IndexRequest => ({
  schemaVersion: RAG_SCHEMA_VERSION,
  eventId: randomUUID(),
  key: { workspaceId: randomUUID(), pageId: randomUUID() },
  inputRevision: toInputRevision(42),
  operation: 'upsert',
  cause: 'attachment',
  occurredAt: new Date().toISOString(),
});

describe('IndexRequest queue schema', () => {
  it('round-trips an exact IndexRequest through the serialized payload', () => {
    const request = validRequest();
    const payload = serializeIndexRequest(request);
    expect(JSON.parse(payload)).toEqual(request);
    expect(parseIndexRequest(payload)).toEqual(request);
  });

  it('carries identifiers and revision metadata only', () => {
    const payload = JSON.parse(serializeIndexRequest(validRequest()));
    expect(Object.keys(payload).sort()).toEqual(
      [
        'cause',
        'eventId',
        'inputRevision',
        'key',
        'occurredAt',
        'operation',
        'schemaVersion',
      ].sort(),
    );
    expect(Object.keys(payload.key).sort()).toEqual(['pageId', 'workspaceId']);
  });

  it('rejects malformed payloads', () => {
    const base = validRequest();
    const invalid: unknown[] = [
      null,
      'not json',
      {},
      { ...base, schemaVersion: 2 },
      { ...base, eventId: 'not-a-uuid' },
      { ...base, key: { ...base.key, workspaceId: 'not-a-uuid' } },
      { ...base, key: { workspaceId: base.key.workspaceId } },
      { ...base, inputRevision: '1.5' },
      { ...base, inputRevision: 42 },
      { ...base, operation: 'patch' },
      { ...base, cause: 'scheduler' },
      { ...base, occurredAt: 'yesterday' },
    ];
    for (const payload of invalid) {
      expect(() => parseIndexRequest(payload)).toThrow();
    }
  });

  it('rejects malformed JSON strings with a clear error', () => {
    expect(() => parseIndexRequest('{')).toThrow(
      'IndexRequest payload is not valid JSON',
    );
  });
});
