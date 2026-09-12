import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { AuditRepo } from '../src/database/repos/audit/audit.repo';
import { SiemOutboxRepo } from '../src/database/repos/siem/siem-outbox.repo';
import { DbInterface } from '../src/database/types/db.interface';
import { KyselyDB } from '../src/database/types/kysely.types';
import { AuditLogData } from '../src/common/events/audit-events';

const databaseUrl = process.env.LIKE157_AUDIT_DATABASE_URL;
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const enabledDestinationId = randomUUID();
const disabledDestinationId = randomUUID();
const otherDestinationId = randomUUID();
let db: KyselyDB;
let auditRepo: AuditRepo;
let outboxRepo: SiemOutboxRepo;

function auditData(): AuditLogData {
  return {
    actorType: 'system',
    event: 'workspace.updated',
    resourceType: 'workspace',
    workspaceId,
  };
}

async function insertDestination(
  id: string,
  destinationWorkspaceId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .insertInto('siemDestinations')
    .values({
      config: {},
      enabled,
      id,
      name: `LIKE-157 ${id}`,
      secrets: 'test-only',
      type: 'webhook',
      workspaceId: destinationWorkspaceId,
    })
    .execute();
}

beforeAll(async () => {
  if (!databaseUrl) {
    throw new Error('LIKE157_AUDIT_DATABASE_URL is required for this PostgreSQL e2e spec.');
  }

  db = new Kysely<DbInterface>({
    dialect: new PostgresJSDialect({ postgres: postgres(databaseUrl) }),
  });
  outboxRepo = new SiemOutboxRepo(db);
  auditRepo = new AuditRepo(db, outboxRepo);

  await db.insertInto('workspaces').values([
    { hostname: `like-157-${workspaceId}`, id: workspaceId, name: 'LIKE-157 audit' },
    { hostname: `like-157-${otherWorkspaceId}`, id: otherWorkspaceId, name: 'LIKE-157 other' },
  ]).execute();
  await insertDestination(enabledDestinationId, workspaceId, true);
  await insertDestination(disabledDestinationId, workspaceId, false);
  await insertDestination(otherDestinationId, otherWorkspaceId, true);
});

afterAll(async () => {
  if (!db) return;
  await db.deleteFrom('siemDeliveryOutbox').where('workspaceId', 'in', [workspaceId, otherWorkspaceId]).execute();
  await db.deleteFrom('audit').where('workspaceId', 'in', [workspaceId, otherWorkspaceId]).execute();
  await db.deleteFrom('siemDestinations').where('id', 'in', [enabledDestinationId, disabledDestinationId, otherDestinationId]).execute();
  await db.deleteFrom('workspaces').where('id', 'in', [workspaceId, otherWorkspaceId]).execute();
  await db.destroy();
});

describe('AuditRepo and SiemOutboxRepo PostgreSQL persistence', () => {
  it('creates outbox work only for enabled destinations in the audit workspace', async () => {
    const entry = await auditRepo.append(auditData());
    const rows = await db.selectFrom('siemDeliveryOutbox').select(['auditId', 'destinationId', 'workspaceId']).where('auditId', '=', entry.id).execute();
    expect(rows).toEqual([{ auditId: entry.id, destinationId: enabledDestinationId, workspaceId }]);
  });

  it('keeps reconciliation idempotent through the destination-audit constraint', async () => {
    const entry = await auditRepo.append(auditData());
    await outboxRepo.createForAudit(entry.id, workspaceId);
    await outboxRepo.createForAudit(entry.id, workspaceId);
    const rows = await db.selectFrom('siemDeliveryOutbox').select('id').where('auditId', '=', entry.id).execute();
    expect(rows).toHaveLength(1);
  });

  it('rolls back audit and outbox rows when the enclosing transaction fails', async () => {
    const rollbackResourceId = randomUUID();
    const outboxBefore = await db
      .selectFrom('siemDeliveryOutbox')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .execute();
    await expect(
      db.transaction().execute(async (trx) => {
        await auditRepo.append({ ...auditData(), resourceId: rollbackResourceId }, trx);
        throw new Error('force audit/outbox rollback');
      }),
    ).rejects.toThrow('force audit/outbox rollback');

    await expect(
      db.selectFrom('audit').select('id').where('workspaceId', '=', workspaceId).where('resourceId', '=', rollbackResourceId).execute(),
    ).resolves.toEqual([]);
    await expect(
      db
        .selectFrom('siemDeliveryOutbox')
        .select('id')
        .where('workspaceId', '=', workspaceId)
        .execute(),
    ).resolves.toHaveLength(outboxBefore.length);
  });
});
