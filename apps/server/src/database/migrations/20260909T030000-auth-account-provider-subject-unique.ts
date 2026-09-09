import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  const duplicates = await sql<{ auth_provider_id: string; count: string }>`
    SELECT auth_provider_id, count(*)::text
    FROM auth_accounts
    WHERE auth_provider_id IS NOT NULL
    GROUP BY auth_provider_id, provider_user_id
    HAVING count(*) > 1
    ORDER BY auth_provider_id
    LIMIT 1
  `.execute(db);
  if (duplicates.rows[0]) {
    const duplicate = duplicates.rows[0];
    throw new Error(
      `Cannot add auth account provider-subject uniqueness: provider ${duplicate.auth_provider_id} has ${duplicate.count} duplicate subjects.`,
    );
  }
  await db.schema
    .alterTable('auth_accounts')
    .addUniqueConstraint('auth_accounts_provider_subject_unique', [
      'auth_provider_id',
      'provider_user_id',
    ])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('auth_accounts')
    .dropConstraint('auth_accounts_provider_subject_unique')
    .execute();
}
