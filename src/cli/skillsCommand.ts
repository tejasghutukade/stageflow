import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { findProjectRoot } from "../project/findProjectRoot.js";

export const SKILLS_USAGE = `Usage:
  sf skills list
  sf skills install --from-path <dir> [--skill-name <name>]
  sf skills install --from-zip <url-or-path> [--skill-name <name>] [--checksum sha256:<hex>]`;

export type SkillsCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
  fetch: typeof globalThis.fetch;
  runDoctor: (scriptPath: string, cwd: string) => number;
};

const defaultIo: SkillsCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  fetch: globalThis.fetch.bind(globalThis),
  runDoctor: (scriptPath, cwd) => {
    const result = spawnSync(process.execPath, [scriptPath, "doctor"], {
      cwd,
      stdio: "pipe",
    });
    return result.status ?? 1;
  },
};

type ParsedSkillsArgs = {
  help: boolean;
  subcommand?: "list" | "install";
  fromPath?: string;
  fromZip?: string;
  skillName?: string;
  checksum?: string;
};

function parseSkillsArgs(args: string[]): ParsedSkillsArgs {
  if (args.length === 0) {
    return { help: false };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true };
  }

  const subcommand = args[0];
  if (subcommand !== "list" && subcommand !== "install") {
    throw new Error(`Unknown skills subcommand: ${subcommand}`);
  }

  let fromPath: string | undefined;
  let fromZip: string | undefined;
  let skillName: string | undefined;
  let checksum: string | undefined;
  let help = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--from-path") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --from-path");
      }
      fromPath = value;
    } else if (arg === "--from-zip") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --from-zip");
      }
      fromZip = value;
    } else if (arg === "--skill-name") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --skill-name");
      }
      skillName = value;
    } else if (arg === "--checksum") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --checksum");
      }
      checksum = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return {
    help,
    subcommand,
    fromPath,
    fromZip,
    skillName,
    checksum,
  };
}

function skillsDirForRoot(projectRoot: string): string {
  return path.join(projectRoot, ".pi", "skills");
}

function shouldCopyRelative(rel: string): boolean {
  const normalized = rel.split(path.sep).join("/");
  if (normalized === "" || normalized === ".") {
    return true;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "test" || segment === "node_modules")) {
    return false;
  }
  if (segments[0] === "scripts") {
    const base = segments[segments.length - 1] ?? "";
    if (base.startsWith("generate-")) {
      return false;
    }
  }
  return true;
}

async function copySkillTree(sourceRoot: string, destRoot: string): Promise<void> {
  await rm(destRoot, { recursive: true, force: true });
  await mkdir(destRoot, { recursive: true });
  await cp(sourceRoot, destRoot, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(sourceRoot, src);
      return shouldCopyRelative(rel);
    },
  });
}

function inferSkillNameFromPath(sourcePath: string): string {
  return path.basename(path.resolve(sourcePath));
}

function inferSkillNameFromZipRef(zipRef: string): string {
  const base = path.basename(zipRef.split("?")[0] ?? zipRef);
  return base.replace(/\.zip$/i, "");
}

function parseChecksum(value: string): string {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(value);
  if (!match) {
    throw new Error("--checksum must be sha256:<64 hex chars>");
  }
  return match[1]!.toLowerCase();
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isZipSlipEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized)) {
    return true;
  }
  return normalized.split("/").some((segment) => segment === "..");
}

type ZipEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function findEndOfCentralDirectory(data: Buffer): number {
  for (let i = data.length - 22; i >= 0; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  throw new Error("invalid zip archive: end of central directory not found");
}

function readZipEntries(data: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(data);
  const centralDirOffset = data.readUInt32LE(eocdOffset + 16);
  const totalEntries = data.readUInt16LE(eocdOffset + 10);
  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("invalid zip archive: central directory entry missing");
    }
    const compressionMethod = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localHeaderOffset = data.readUInt32LE(offset + 42);
    const name = data.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function extractZipBuffer(data: Buffer, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = readZipEntries(data);

  for (const entry of entries) {
    if (entry.name.endsWith("/")) {
      continue;
    }
    if (isZipSlipEntry(entry.name)) {
      throw new Error("zip entry path rejected (zip-slip)");
    }

    const localOffset = entry.localHeaderOffset;
    if (data.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("invalid zip archive: local file header missing");
    }
    const nameLength = data.readUInt16LE(localOffset + 26);
    const extraLength = data.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + nameLength + extraLength;
    const compressed = data.subarray(
      dataOffset,
      dataOffset + entry.compressedSize,
    );

    let content: Buffer;
    if (entry.compressionMethod === 0) {
      content = compressed;
    } else if (entry.compressionMethod === 8) {
      content = inflateRawSync(compressed);
    } else {
      throw new Error(`unsupported zip compression method: ${entry.compressionMethod}`);
    }

    if (content.length !== entry.uncompressedSize) {
      throw new Error("invalid zip archive: uncompressed size mismatch");
    }

    const outPath = path.join(destDir, entry.name);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, content);
  }
}

async function resolveZipBytes(
  zipRef: string,
  io: SkillsCommandIo,
): Promise<Buffer> {
  if (zipRef.startsWith("https://")) {
    const response = await io.fetch(zipRef);
    if (!response.ok) {
      throw new Error(`failed to fetch zip: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  if (/^https?:\/\//i.test(zipRef)) {
    throw new Error("only HTTPS URLs are supported for --from-zip");
  }
  return readFile(path.resolve(zipRef));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findSkillRoot(
  extractRoot: string,
  skillName: string,
): Promise<string> {
  const directBin = path.join(extractRoot, "bin", `${skillName}.mjs`);
  if (await pathExists(directBin)) {
    return extractRoot;
  }

  const nestedRoot = path.join(extractRoot, skillName);
  const nestedBin = path.join(nestedRoot, "bin", `${skillName}.mjs`);
  if (await pathExists(nestedBin)) {
    return nestedRoot;
  }

  const found = await findSkillRootByBin(extractRoot, skillName);
  if (found !== undefined) {
    return found;
  }

  const bySkillMd = await findSkillRootBySkillMd(extractRoot);
  if (bySkillMd !== undefined) {
    return bySkillMd;
  }

  throw new Error(`could not locate skill root in extracted archive`);
}

async function findSkillRootByBin(
  dir: string,
  skillName: string,
): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    const binScript = path.join(fullPath, "bin", `${skillName}.mjs`);
    if (await pathExists(binScript)) {
      return fullPath;
    }
    const nested = await findSkillRootByBin(fullPath, skillName);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

async function findSkillRootBySkillMd(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      return dir;
    }
    if (entry.isDirectory()) {
      const nested = await findSkillRootBySkillMd(fullPath);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

export type InstallProjectSkillInput = {
  projectRoot: string;
  fromPath?: string;
  fromZip?: string;
  zipBytes?: Uint8Array;
  skillName?: string;
  checksum?: string;
  io?: Partial<SkillsCommandIo>;
};

export type InstallProjectSkillResult =
  | { ok: true; skillName: string; destPath: string; message: string }
  | { ok: false; error: string; doctorFailed?: boolean };

type InstallSourceInput = {
  fromPath?: string;
  fromZip?: string;
  zipBytes?: Uint8Array;
  skillName?: string;
  checksum?: string;
};

async function resolveInstallSource(
  input: InstallSourceInput,
  io: SkillsCommandIo,
): Promise<{ sourceRoot: string; skillName: string; cleanup?: () => Promise<void> }> {
  const hasPath = input.fromPath !== undefined;
  const hasZip = input.fromZip !== undefined;
  const hasZipBytes = input.zipBytes !== undefined;
  const sourceCount = Number(hasPath) + Number(hasZip) + Number(hasZipBytes);
  if (sourceCount !== 1) {
    throw new Error(
      hasZipBytes
        ? "specify exactly one of fromPath, fromZip, or zipBytes"
        : "specify exactly one of --from-path or --from-zip",
    );
  }

  if (input.fromPath !== undefined) {
    const sourceRoot = path.resolve(input.fromPath);
    try {
      const sourceStat = await stat(sourceRoot);
      if (!sourceStat.isDirectory()) {
        throw new Error("source path not found");
      }
    } catch {
      throw new Error("source path not found");
    }
    const skillName = input.skillName ?? inferSkillNameFromPath(input.fromPath);
    return { sourceRoot, skillName };
  }

  let zipBytes: Buffer;
  let inferredZipName: string | undefined;
  if (input.zipBytes !== undefined) {
    zipBytes = Buffer.from(input.zipBytes);
  } else {
    const zipRef = input.fromZip!;
    zipBytes = await resolveZipBytes(zipRef, io);
    inferredZipName = inferSkillNameFromZipRef(zipRef);
  }

  if (input.checksum !== undefined) {
    const expected = parseChecksum(input.checksum);
    const actual = sha256Hex(zipBytes);
    if (actual !== expected) {
      throw new Error("checksum mismatch");
    }
  }

  const extractDir = await mkdtemp(path.join(tmpdir(), "sf-skill-zip-"));
  await extractZipBuffer(zipBytes, extractDir);
  const lookupName = input.skillName ?? inferredZipName ?? "skill";
  const sourceRoot = await findSkillRoot(extractDir, lookupName);
  const skillName = input.skillName ?? inferredZipName ?? path.basename(sourceRoot);
  return {
    sourceRoot,
    skillName,
    cleanup: async () => {
      await rm(extractDir, { recursive: true, force: true });
    },
  };
}

async function listSkills(projectRoot: string, io: SkillsCommandIo): Promise<void> {
  const skillsDir = skillsDirForRoot(projectRoot);
  let names: string[];
  try {
    names = await readdir(skillsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }

  for (const name of names.sort()) {
    const skillDir = path.join(skillsDir, name);
    const skillStat = await stat(skillDir);
    if (!skillStat.isDirectory()) {
      continue;
    }

    let version = "—";
    try {
      const pkgRaw = await readFile(path.join(skillDir, "package.json"), "utf8");
      const pkg = JSON.parse(pkgRaw) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        version = pkg.version;
      }
    } catch {
      // no package.json
    }

    io.log(`${name}\t${version}\tbin/${name}.mjs`);
  }
}

export async function installProjectSkill(
  input: InstallProjectSkillInput,
): Promise<InstallProjectSkillResult> {
  const io: SkillsCommandIo = { ...defaultIo, ...input.io };
  try {
    const resolved = await resolveInstallSource(
      {
        fromPath: input.fromPath,
        fromZip: input.fromZip,
        zipBytes: input.zipBytes,
        skillName: input.skillName,
        checksum: input.checksum,
      },
      io,
    );
    try {
      const destRoot = path.join(skillsDirForRoot(input.projectRoot), resolved.skillName);
      await copySkillTree(resolved.sourceRoot, destRoot);

      const doctorScript = path.join(destRoot, "bin", `${resolved.skillName}.mjs`);
      if (await pathExists(doctorScript)) {
        const doctorCode = io.runDoctor(doctorScript, input.projectRoot);
        if (doctorCode !== 0) {
          io.error("skill doctor failed");
          return { ok: false, error: "skill doctor failed", doctorFailed: true };
        }
      }

      const message = `Installed skill ${resolved.skillName} to ${destRoot}`;
      io.log(message);
      return {
        ok: true,
        skillName: resolved.skillName,
        destPath: destRoot,
        message,
      };
    } finally {
      if (resolved.cleanup) {
        await resolved.cleanup();
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    io.error(error);
    return { ok: false, error };
  }
}

export async function runSkillsCommand(
  args: string[],
  options: { cwd?: string; projectRoot?: string; io?: Partial<SkillsCommandIo> } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = options.projectRoot ?? findProjectRoot(cwd) ?? path.resolve(cwd);
  const io: SkillsCommandIo = { ...defaultIo, ...options.io };

  try {
    const parsed = parseSkillsArgs(args);
    if (parsed.help) {
      io.error(SKILLS_USAGE);
      return 0;
    }

    if (parsed.subcommand === undefined) {
      io.error(SKILLS_USAGE);
      return 1;
    }

    if (parsed.subcommand === "list") {
      await listSkills(projectRoot, io);
      return 0;
    }

    const result = await installProjectSkill({
      projectRoot,
      fromPath: parsed.fromPath,
      fromZip: parsed.fromZip,
      skillName: parsed.skillName,
      checksum: parsed.checksum,
      io,
    });
    return result.ok ? 0 : 1;
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function createStoredZip(
  files: { name: string; content: string | Buffer }[],
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const content = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, "utf8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + content.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}
