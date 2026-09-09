import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('siem_delivery_outbox')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('destination_id', 'uuid', (column) =>
      column.notNull().references('siem_destinations.id').onDelete('cascade'),
    )
    .addColumn('audit_id', 'uuid', (column) =>
      column.notNull().references('audit.id').onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (column) =>
      column.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('delivered_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('siem_delivery_outbox_destination_audit_unique', [
      'destination_id',
      'audit_id',
    ])
    .execute();

  await sql`
    CREATE INDEX siem_delivery_outbox_pending_idx
    ON siem_delivery_outbox (destination_id, created_at, id)
    WHERE delivered_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('siem_delivery_outbox').execute();
}
