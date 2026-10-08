// Database bootstrap: opens the SQLite file, applies per-connection pragmas,
// and applies the schema exactly once (guarded by PRAGMA user_version).
//
// The DB path comes from the BUDGET_DB_PATH env var, or an explicit argument
// (tests pass ':memory:'). There is no silent default path.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const DB_PATH_ENV_VAR = 'BUDGET_DB_PATH';
export const SCHEMA_VERSION = 1;

const MEMORY_DB_PATH = ':memory:';
const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export function openDb(path = process.env[DB_PATH_ENV_VAR]) {
    if (!path) {
        throw new Error(
            `No database path given: pass one to openDb() or set ${DB_PATH_ENV_VAR}`
        );
    }
    if (path !== MEMORY_DB_PATH) {
        mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');    // off by default in SQLite; required per connection
    applySchema(db);
    return db;
}

function applySchema(db) {
    const version = db.pragma('user_version', { simple: true });
    if (version > SCHEMA_VERSION) {
        throw new Error(
            `Database schema version ${version} is newer than this code supports (${SCHEMA_VERSION})`
        );
    }
    if (version === SCHEMA_VERSION) {
        return;
    }
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    db.transaction(() => {
        db.exec(schema);
        // Not user input: SCHEMA_VERSION is a module constant, and pragmas
        // cannot be parameterized.
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
}
