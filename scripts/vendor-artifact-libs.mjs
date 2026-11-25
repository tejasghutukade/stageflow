import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "src/artifacts/library/htmlLibraries.json");
const update = process.argv.includes("--update");

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const libraries = catalog.libraries;

let mismatches = 0;

for (const library of libraries) {
  let bytes = 0;
  for (const file of library.files) {
    const source = path.join(root, "node_modules", library.packageName, file.packageFile);
    const body = readFileSync(source);
    bytes += body.length;
    const integrity = `sha384-${createHash("sha384").update(body).digest("base64")}`;
    if (integrity !== file.integrity) {
      mismatches += 1;
      console.error(`${library.name}@${library.version} ${file.path} integrity ${file.integrity} != ${integrity}`);
      if (update) file.integrity = integrity;
    }
    const destination = path.join(root, "dist", "sandbox-libs", `${library.name}@${library.version}`, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, body);
  }
  if (bytes !== library.bytes) {
    mismatches += 1;
    console.error(`${library.name}@${library.version} bytes ${library.bytes} != ${bytes}`);
    if (update) library.bytes = bytes;
  }
}

if (update) {
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

const distCatalog = path.join(root, "dist", "artifacts", "library", "htmlLibraries.json");
mkdirSync(path.dirname(distCatalog), { recursive: true });
copyFileSync(catalogPath, distCatalog);

if (mismatches > 0 && !update) {
  console.error("library integrity does not match node_modules; run node scripts/vendor-artifact-libs.mjs --update");
  process.exit(1);
}
