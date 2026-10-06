export type StoreSchemaErrorCode =
  | "store_schema_migration_required"
  | "store_schema_too_new";

export class StoreSchemaError extends Error {
  readonly code: StoreSchemaErrorCode;

  constructor(message: string, code: StoreSchemaErrorCode) {
    super(message);
    this.name = "StoreSchemaError";
    this.code = code;
  }
}
