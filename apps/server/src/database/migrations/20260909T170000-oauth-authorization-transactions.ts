import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('oauth_authorization_transactions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('csrf_hash', 'text', (col) => col.notNull())
    .addColumn('session_id', 'uuid', (col) => col.notNull())
    .addColumn('user_id', 'uuid', (col) => col.notNull())
    .addColumn('workspace_id', 'uuid', (col) => col.notNull())
    .addColumn('client_id', 'uuid', (col) => col.notNull())
    .addColumn('redirect_uri', 'text', (col) => col.notNull())
    .addColumn('scopes', 'jsonb', (col) => col.notNull())
    .addColumn('code_challenge', 'text', (col) => col.notNull())
    .addColumn('state', 'text')
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('consumed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createIndex('oauth_authorization_transactions_token_hash_idx')
    .on('oauth_authorization_transactions')
    .column('token_hash')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropTable('oauth_authorization_transactions')
    .ifExists()
    .execute();
}
