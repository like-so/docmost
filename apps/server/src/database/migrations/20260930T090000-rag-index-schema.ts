import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('rag_generations')
    .ifNotExists()
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (column) =>
      column.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('page_id', 'uuid', (column) =>
      column.references('pages.id').onDelete('cascade').notNull(),
    )
    .addColumn('input_revision', 'bigint', (column) => column.notNull())
    .addColumn('profile_hash', 'varchar', (column) => column.notNull())
    .addColumn('status', 'varchar', (column) =>
      column.notNull().defaultTo('staged'),
    )
    .addColumn('error_code', 'varchar')
    .addColumn('chunk_count', 'integer')
    .addColumn('published_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createIndex('idx_rag_generations_page')
    .ifNotExists()
    .on('rag_generations')
    .columns(['workspace_id', 'page_id', 'status'])
    .execute();

  await db.schema
    .createTable('rag_chunks')
    .ifNotExists()
    .addColumn('id', 'varchar', (column) => column.primaryKey())
    .addColumn('generation_id', 'uuid', (column) =>
      column.references('rag_generations.id').onDelete('cascade').notNull(),
    )
    .addColumn('workspace_id', 'uuid', (column) =>
      column.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('page_id', 'uuid', (column) => column.notNull())
    .addColumn('attachment_id', 'uuid')
    .addColumn('ordinal', 'integer', (column) => column.notNull())
    .addColumn('text', 'text', (column) => column.notNull())
    .addColumn('token_count', 'integer', (column) => column.notNull())
    .addColumn('text_hash', 'varchar', (column) => column.notNull())
    .addColumn('locator', 'jsonb', (column) => column.notNull())
    .addColumn('embedding', 'jsonb')
    .addColumn('embedding_dimensions', 'integer')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createIndex('idx_rag_chunks_generation')
    .ifNotExists()
    .on('rag_chunks')
    .columns(['generation_id', 'ordinal'])
    .execute();
  await db.schema
    .createIndex('idx_rag_chunks_page')
    .ifNotExists()
    .on('rag_chunks')
    .columns(['workspace_id', 'page_id'])
    .execute();

  await db.schema
    .createTable('rag_workspace_profile')
    .ifNotExists()
    .addColumn('workspace_id', 'uuid', (column) =>
      column.primaryKey().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('enabled', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .addColumn('profile_id', 'uuid')
    .addColumn('profile_hash', 'varchar')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable('rag_source_state')
    .ifNotExists()
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (column) =>
      column.references('workspaces.id').onDelete('cascade').notNull(),
    )
    // No pages foreign key: the tombstone must survive hard deletion so late
    // work can be rejected after the source row is gone.
    .addColumn('page_id', 'uuid', (column) => column.notNull())
    .addColumn('desired_input_revision', 'bigint', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('source_status', 'varchar', (column) => column.notNull())
    .addColumn('last_operation', 'varchar')
    .addColumn('last_cause', 'varchar')
    .addColumn('published_input_revision', 'bigint')
    // Generation rows cascade away with their page/workspace; SET NULL clears
    // this pointer so the tombstone row itself survives hard deletion.
    .addColumn('published_generation_id', 'uuid', (column) =>
      column.references('rag_generations.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('rag_source_state_key', ['workspace_id', 'page_id'])
    .execute();

  await db.schema
    .createTable('rag_outbox')
    .ifNotExists()
    // Primary key is the eventId; duplicate event identity is a no-op.
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('workspace_id', 'uuid', (column) =>
      column.references('workspaces.id').onDelete('cascade').notNull(),
    )
    .addColumn('page_id', 'uuid', (column) => column.notNull())
    .addColumn('input_revision', 'bigint', (column) => column.notNull())
    .addColumn('operation', 'varchar', (column) => column.notNull())
    .addColumn('cause', 'varchar', (column) => column.notNull())
    .addColumn('schema_version', 'integer', (column) =>
      column.notNull().defaultTo(1),
    )
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull())
    .addColumn('status', 'varchar', (column) =>
      column.notNull().defaultTo('pending'),
    )
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('last_error_code', 'varchar')
    .addColumn('delivered_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createIndex('idx_rag_outbox_pending')
    .ifNotExists()
    .on('rag_outbox')
    .columns(['status', 'created_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('rag_outbox').ifExists().execute();
  await db.schema.dropTable('rag_workspace_profile').ifExists().execute();
  await db.schema.dropTable('rag_source_state').ifExists().execute();
  await db.schema.dropTable('rag_chunks').ifExists().execute();
  await db.schema.dropTable('rag_generations').ifExists().execute();
}
