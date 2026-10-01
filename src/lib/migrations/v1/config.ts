export const V1_MIGRATION_ENABLED: boolean = true;

export class V1MigrationError extends Error {
  override name = 'V1MigrationError';
}
