#!/usr/bin/env node
// Usage: node scripts/fetch-server.mjs [--target linux-x64|win32-x64] [--from <dir|archive|url>]
// Puts offgrid-server and the libraries it needs into server/, for `vsce package --target`.
// --from defaults to the offgrid release named by "offgridServer" in package.json.

import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const PLATFORMS = {
  "linux-x64": { name: "linux-x86_64", ext: "tar.gz" },
  "win32-x64": { name: "windows-x86_64", ext: "zip" },
};
const target = opt("target") ?? `${process.platform}-${process.arch}`;
const platform = PLATFORMS[target];
if (!platform) {
  console.error(`Unsupported target ${target} (have: ${Object.keys(PLATFORMS).join(", ")})`);
  process.exit(1);
}
const version = pkg.offgridServer;
const from =
  opt("from") ??
  `https://github.com/Pinta365/offgrid/releases/download/v${version}/offgrid-${version}-${platform.name}.${platform.ext}`;

const tmp = mkdtempSync(join(tmpdir(), "offgrid-server-"));
try {
  let dir = from;
  if (/^https?:\/\//.test(from)) {
    console.log(`Downloading ${from}`);
    const res = await fetch(from);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${from}`);
    }
    dir = join(tmp, basename(new URL(from).pathname));
    writeFileSync(dir, Buffer.from(await res.arrayBuffer()));
  }
  if (statSync(dir).isFile()) {
    const out = join(tmp, "unpacked");
    execFileSync("mkdir", ["-p", out]);
    if (dir.endsWith(".zip")) {
      execFileSync("unzip", ["-q", dir, "-d", out]);
    } else {
      execFileSync("tar", ["xzf", dir, "-C", out]);
    }
    // Archives hold one top-level folder (offgrid-<version>-<platform>).
    const entries = readdirSync(out);
    dir = entries.length === 1 ? join(out, entries[0]) : out;
  }
  if (!existsSync(join(dir, "bin"))) {
    throw new Error(`${dir} is not an offgrid package (no bin/)`);
  }

  const server = join(root, "server");
  rmSync(server, { recursive: true, force: true });
  // Keep the package layout (bin/ and lib/: RPATHs and DLL lookup depend on it), minus the C ABI.
  const skip = /^(liboffgrid\.(so|dylib)|offgrid\.(dll|lib)|liboffgrid\.dll\.a)$/;
  for (const sub of ["bin", "lib"]) {
    if (existsSync(join(dir, sub))) {
      cpSync(join(dir, sub), join(server, sub), { recursive: true, filter: (src) => !skip.test(basename(src)) });
    }
  }
  const exe = join(server, "bin", target.startsWith("win32") ? "offgrid-server.exe" : "offgrid-server");
  if (!existsSync(exe)) {
    throw new Error(`no offgrid-server in ${dir}/bin`);
  }
  console.log(`server/ ready for ${target} from ${from}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
