import Database from "better-sqlite3";

/** Columns of the identity database that hold a credential in the clear. */
const SECRET_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "identity_connections", column: "secret" }, // OIDC client secret
  { table: "identity_sessions", column: "refresh_secret" }, // provider refresh token
];

/**
 * Removes the credentials from a copy of the identity database, for an archive made without secrets. People,
 * access, revocations and replay protection stay. After a restore an OIDC connection needs its client secret
 * entered again and a signed-in person signs in again. Returns whether anything was removed.
 */
export function removeIdentitySecrets(copyPath: string): boolean {
  const db = new Database(copyPath, { fileMustExist: true });
  try {
    // Overwrite the freed bytes, so a removed value is not left behind in the file.
    db.pragma("secure_delete = ON");
    let removed = false;
    for (const { table, column } of SECRET_COLUMNS) {
      const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>;
      if (!columns.some((found) => found.name === column)) continue;
      if (db.prepare(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IS NOT NULL`).run().changes > 0) removed = true;
    }
    db.exec("VACUUM");
    return removed;
  } finally {
    db.close();
  }
}
