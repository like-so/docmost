import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('page_embeddings')
    .ifNotExists()
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('page_id', 'uuid', (column) =>
      column.references('pages.id').onDelete('cascade').notNull(),
    )
    .addColumn('space_id', 'uuid', (column) =>
      column.references('spaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('workspace_id', 'uuid', (column) =>
      column.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('attachment_id', 'uuid')
    .addColumn('model_name', 'varchar', (column) => column.notNull())
    .addColumn('model_dimensions', 'integer', (column) => column.notNull())
    .addColumn('embedding', 'jsonb', (column) => column.notNull())
    .addColumn('chunk_index', 'integer', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('chunk_start', 'integer', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('chunk_length', 'integer', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('metadata', 'jsonb', (column) =>
      column.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz')
    .execute();
  await db.schema
    .createIndex('idx_page_embeddings_page')
    .ifNotExists()
    .on('page_embeddings')
    .columns(['workspace_id', 'page_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('page_embeddings').ifExists().execute();
}
