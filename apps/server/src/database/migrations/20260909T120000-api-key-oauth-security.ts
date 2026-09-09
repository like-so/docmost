import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('api_keys')
    .addColumn('secret_hash', 'text')
    .execute();
  await db.schema.alterTable('api_keys').addColumn('scopes', 'jsonb').execute();
  await db.schema
    .createIndex('api_keys_secret_hash_idx')
    .on('api_keys')
    .column('secret_hash')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('api_keys_secret_hash_idx').execute();
  await db.schema.alterTable('api_keys').dropColumn('scopes').execute();
  await db.schema.alterTable('api_keys').dropColumn('secret_hash').execute();
}
