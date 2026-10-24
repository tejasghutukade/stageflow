export class CsvParseError extends Error {
  readonly record: number;

  constructor(message: string, record: number) {
    super(message);
    this.name = "CsvParseError";
    this.record = record;
  }
}

export type ParseCsvOptions = { delimiter?: string };

/** RFC 4180 parser. Returns raw records; blank lines are kept as `[""]`. */
export function parseCsv(text: string, options: ParseCsvOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ",";
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === "\n" || delimiter === "\r") {
    throw new Error(`Invalid CSV delimiter: ${JSON.stringify(delimiter)}`);
  }
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let i = 0;

  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        const next = src[i];
        if (next !== undefined && next !== delimiter && next !== "\n" && next !== "\r") {
          throw new CsvParseError(
            `unexpected character after closing quote in row ${records.length + 1}`,
            records.length + 1,
          );
        }
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (fieldStarted) {
        throw new CsvParseError(
          `unexpected quote inside unquoted field in row ${records.length + 1}`,
          records.length + 1,
        );
      }
      inQuotes = true;
      fieldStarted = true;
      i += 1;
    } else if (ch === delimiter) {
      endField();
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      endRecord();
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      fieldStarted = true;
      i += 1;
    }
  }
  if (inQuotes) {
    throw new CsvParseError(
      `unterminated quoted field in row ${records.length + 1}`,
      records.length + 1,
    );
  }
  if (fieldStarted || field !== "" || record.length > 0) endRecord();
  return records;
}
