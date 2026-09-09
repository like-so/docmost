import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('group_membership_sources')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('group_id', 'uuid', (column) =>
      column.references('groups.id').onDelete('cascade').notNull(),
    )
    .addColumn('user_id', 'uuid', (column) =>
      column.references('users.id').onDelete('cascade').notNull(),
    )
    .addColumn('source', 'varchar', (column) => column.notNull())
    .addColumn('created_membership', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('group_membership_sources_unique', [
      'group_id',
      'user_id',
      'source',
    ])
    .execute();

  await db.schema
    .createIndex('idx_group_membership_sources_user_source')
    .on('group_membership_sources')
    .columns(['user_id', 'source'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('group_membership_sources').execute();
}
