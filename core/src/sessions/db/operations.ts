/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MikroORM, Options as MikroORMOptions} from '@mikro-orm/core';
import {
  ENTITIES,
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageMetadata,
} from './schema.js';

/**
 * How long a socket may idle before the kernel starts sending TCP keepalive
 * probes. Cloud networks drop idle connections without telling either end
 * (~10 minutes on Google Cloud), so probing has to start well inside that
 * window. Kernel probes rather than a JavaScript timer: a serverless host is
 * only guaranteed CPU while it serves a request, so an in-process timer may
 * never fire during the idle period it exists to cover.
 */
const KEEPALIVE_INITIAL_DELAY_MS = 60_000;

/**
 * Pooling and socket options that stop a pooled connection from outliving the
 * socket underneath it.
 *
 * The pool's default floor of two connections keeps sockets checked in
 * forever, so a deployment that goes quiet between requests hands the next
 * caller a connection the network has already dropped. That surfaces as a
 * stalled request — the failure is only discovered when the write is attempted
 * — so keep no floor and let genuinely idle connections be reaped instead.
 *
 * sqlite is exempt: there is no socket, and an in-memory database lives inside
 * its connection, so reaping it would discard the data.
 */
function getIdleSafeConnectionOptions(uri: string): MikroORMOptions {
  if (uri.startsWith('sqlite://')) {
    return {} as MikroORMOptions;
  }

  const isPostgres =
    uri.startsWith('postgres://') || uri.startsWith('postgresql://');

  return {
    pool: {min: 0},
    // `keepAlive` is a node-postgres option; the other drivers spell it
    // differently or enable it themselves.
    ...(isPostgres && {
      driverOptions: {
        connection: {
          keepAlive: true,
          keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
        },
      },
    }),
  } as MikroORMOptions;
}

/**
 * Parses a database connection URI and returns MikroORM Options.
 *
 * @param uri The database connection URI (e.g., "postgres://user:password@host:port/database")
 * @returns MikroORM Options configured for the database
 * @throws Error if the URI is invalid or unsupported
 */
export async function getConnectionOptionsFromUri(
  uri: string,
): Promise<MikroORMOptions> {
  let driver: unknown | undefined;

  if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    const {PostgreSqlDriver} = await import('@mikro-orm/postgresql');
    driver = PostgreSqlDriver;
  } else if (uri.startsWith('mysql://')) {
    const {MySqlDriver} = await import('@mikro-orm/mysql');
    driver = MySqlDriver;
  } else if (uri.startsWith('mariadb://')) {
    const {MariaDbDriver} = await import('@mikro-orm/mariadb');
    driver = MariaDbDriver;
  } else if (uri.startsWith('sqlite://')) {
    const {SqliteDriver} = await import('@mikro-orm/sqlite');
    driver = SqliteDriver;
  } else if (uri.startsWith('mssql://')) {
    const {MsSqlDriver} = await import('@mikro-orm/mssql');
    driver = MsSqlDriver;
  } else {
    throw new Error(`Unsupported database URI: ${uri}`);
  }

  if (uri === 'sqlite://:memory:') {
    return {
      entities: ENTITIES,
      dbName: ':memory:',
      driver,
    } as MikroORMOptions;
  }

  const {host, port, username, password, pathname} = new URL(uri);
  const hostName = host.split(':')[0];

  const dbName = uri.startsWith('sqlite://')
    ? uri.substring('sqlite://'.length)
    : pathname.slice(1);

  return {
    entities: ENTITIES,
    dbName,
    host: hostName,
    port: port ? parseInt(port) : undefined,
    user: username,
    password,
    driver,
    ...getIdleSafeConnectionOptions(uri),
  } as MikroORMOptions;
}

/**
 * Creates a database and tables if they don't exist.
 *
 * @param orm The MikroORM instance.
 * @returns Promise<void>
 */
export async function ensureDatabaseCreated(orm: MikroORM): Promise<void> {
  // creates database if it doesn't exist
  await orm.schema.ensureDatabase();

  // creates tables if they don't exist. Safe mode prevents dropping columns or tables.
  await orm.schema.updateSchema({safe: true});
}

/**
 * Validates the schema version.
 *
 * @param orm The MikroORM instance.
 * @throws Error if the schema version is not compatible.
 */
export async function validateDatabaseSchemaVersion(orm: MikroORM) {
  const em = orm.em.fork();
  const existing = await em.findOne(StorageMetadata, {
    key: SCHEMA_VERSION_KEY,
  });

  if (existing) {
    if (existing.value !== SCHEMA_VERSION_1_JSON) {
      throw new Error(
        `ADK Database schema version ${existing.value} is not compatible.`,
      );
    }
    return;
  }

  const newVersion = em.create(StorageMetadata, {
    key: SCHEMA_VERSION_KEY,
    value: SCHEMA_VERSION_1_JSON,
  });

  await em.persist(newVersion).flush();
}
