import { migrate } from "drizzle-orm/postgres-js/migrator";

import type { Database } from "./client.js";

export const MIGRATIONS_SCHEMA = "chitchat_message_service";
export const MIGRATIONS_TABLE = "__drizzle_migrations";

export async function runDatabaseMigrations(
  db: Database,
  migrationsFolder = "drizzle",
): Promise<void> {
  await migrate(db, {
    migrationsFolder,
    migrationsSchema: MIGRATIONS_SCHEMA,
    migrationsTable: MIGRATIONS_TABLE,
  });
}
