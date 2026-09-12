import { Kysely, sql } from 'kysely';

const LEGACY_PROVIDER = 'legacy';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('group_membership_sources')
    .addColumn('provider_id', 'varchar', (column) =>
      column.notNull().defaultTo(''),
    )
    .execute();
  await sql`
    UPDATE group_membership_sources
    SET provider_id = ${LEGACY_PROVIDER}
    WHERE source = 'sso' AND provider_id = ''
  `.execute(db);
  await sql`
    INSERT INTO group_membership_sources
      (group_id, user_id, source, provider_id, created_membership)
    SELECT group_id, user_id, 'manual', '', false
    FROM group_users
    WHERE NOT EXISTS (
      SELECT 1
      FROM group_membership_sources
      WHERE group_membership_sources.group_id = group_users.group_id
        AND group_membership_sources.user_id = group_users.user_id
    )
  `.execute(db);
  const unassigned = await sql<{ count: string }>`
    SELECT count(*)::text AS count
    FROM group_membership_sources
    WHERE source = 'sso' AND provider_id = ''
  `.execute(db);
  if (Number(unassigned.rows[0]?.count ?? 0) !== 0) {
    throw new Error('Legacy SSO memberships require a provider identity');
  }
  await db.schema
    .alterTable('group_membership_sources')
    .dropConstraint('group_membership_sources_unique')
    .execute();
  await db.schema
    .alterTable('group_membership_sources')
    .addUniqueConstraint('group_membership_sources_unique', [
      'group_id',
      'user_id',
      'source',
      'provider_id',
    ])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('group_membership_sources')
    .dropConstraint('group_membership_sources_unique')
    .execute();
  await db.schema
    .alterTable('group_membership_sources')
    .dropColumn('provider_id')
    .execute();
  await db.schema
    .alterTable('group_membership_sources')
    .addUniqueConstraint('group_membership_sources_unique', [
      'group_id',
      'user_id',
      'source',
    ])
    .execute();
}
