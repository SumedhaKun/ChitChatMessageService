import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseConnection {
  db: Database;
  sql: Sql;
}

let connection: DatabaseConnection | undefined;

export function createDatabaseConnection(
  databaseUrl: string,
): DatabaseConnection {
  if (databaseUrl.length === 0) {
    throw new Error("DATABASE_URL must not be empty");
  }

  const sql = postgres(databaseUrl, {
    max: process.env.VERCEL === undefined ? 10 : 1,
    prepare: false,
  });

  return {
    db: drizzle(sql, { schema }),
    sql,
  };
}

export function getDatabaseConnection(): DatabaseConnection {
  if (connection !== undefined) {
    return connection;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error("DATABASE_URL is required");
  }

  connection = createDatabaseConnection(databaseUrl);
  return connection;
}

export async function closeDatabaseConnection(): Promise<void> {
  if (connection === undefined) {
    return;
  }

  await connection.sql.end();
  connection = undefined;
}
