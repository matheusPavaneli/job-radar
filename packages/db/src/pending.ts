export interface MigrationFile {
  name: string;
  checksum: string;
}

/**
 * Returns the migrations still to apply, in lexical order.
 * Throws if an already-applied migration's file changed: applied history is immutable,
 * so a fix must ship as a new migration.
 */
export function pendingMigrations(files: readonly MigrationFile[], applied: ReadonlyMap<string, string>): MigrationFile[] {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pending: MigrationFile[] = [];
  for (const file of sorted) {
    const previous = applied.get(file.name);
    if (previous === undefined) pending.push(file);
    else if (previous !== file.checksum) throw new Error(`Migration ${file.name} changed after being applied`);
  }
  return pending;
}
