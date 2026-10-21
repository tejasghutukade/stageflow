import { readConnectionsText, writeConnectionsText } from "./configWriter.js";

/** What the edit module needs from the secret store. `ChannelSecretStore` satisfies it. */
export interface SecretWriter {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  deleteWithPrefix(prefix: string): void;
}

export type ConnectionEdit = {
  /** Secret store name to value. Written before the file so a reference never points at nothing. */
  secrets?: Readonly<Record<string, string>>;
  /** Pure transform of the file text. May name secret prefixes to drop once the edit has committed. */
  rewrite(text: string): { text: string; dropSecretPrefixes?: readonly string[] };
};

export type ConnectionEditsOptions = {
  file: () => string;
  store: SecretWriter;
  /** Throws if the new text would not load. Runs before anything is written to the file. */
  validate: (text: string) => void;
};

/**
 * One atomic change to connections: secrets and file together. Either both change or neither
 * does. A secret that already existed is restored to its previous value, not deleted, and a
 * failure while writing, validating or saving leaves nothing half-applied. Dropping the secrets
 * of a removed connection happens only after the file has been saved, and a failure there only
 * leaves an orphaned secret behind, never a broken connection.
 */
export class ConnectionEdits {
  constructor(private readonly options: ConnectionEditsOptions) {}

  apply(edit: ConnectionEdit): void {
    const { store } = this.options;
    const file = this.options.file();
    const text = readConnectionsText(file);
    const previous = new Map<string, string | undefined>();
    let drop: readonly string[] = [];
    try {
      for (const [name, value] of Object.entries(edit.secrets ?? {})) {
        previous.set(name, store.get(name));
        store.set(name, value);
      }
      const next = edit.rewrite(text);
      this.options.validate(next.text);
      writeConnectionsText(file, next.text);
      drop = next.dropSecretPrefixes ?? [];
    } catch (error) {
      for (const [name, value] of previous) {
        try {
          if (value === undefined) store.delete(name);
          else store.set(name, value);
        } catch {
          /* restoring is best effort; the original error is the one to report */
        }
      }
      throw error;
    }
    for (const prefix of drop) {
      try {
        store.deleteWithPrefix(prefix);
      } catch {
        /* an orphaned secret is harmless and is overwritten if the id is reused */
      }
    }
  }
}
