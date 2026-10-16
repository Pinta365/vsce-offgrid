#!/usr/bin/env node
// Usage: node scripts/release.mjs [patch|minor|major|x.y.z]
// Bumps version, finalizes CHANGELOG, commits, tags, and pushes.

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function run(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

// --- Determine new version ---
const pkgPath = resolve(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;

const bump = process.argv[2] ?? "patch";
let next;

if (/^\d+\.\d+\.\d+$/.test(bump)) {
  next = bump;
} else {
  const [major, minor, patch] = current.split(".").map(Number);
  if (bump === "major") next = `${major + 1}.0.0`;
  else if (bump === "minor") next = `${major}.${minor + 1}.0`;
  else next = `${major}.${minor}.${patch + 1}`;
}

console.log(`Releasing ${current} → ${next}`);

// --- Update CHANGELOG ---
const changelogPath = resolve(root, "CHANGELOG.md");
let changelog = readFileSync(changelogPath, "utf8");

const today = new Date().toISOString().slice(0, 10);
const unreleasedHeader = /^## \[Unreleased\]/im;

if (!unreleasedHeader.test(changelog)) {
  console.error("No '## [Unreleased]' section found in CHANGELOG.md. Aborting.");
  process.exit(1);
}

// Replace [Unreleased] with the versioned entry, prepend new [Unreleased] section
changelog = changelog.replace(
  unreleasedHeader,
  `## [Unreleased]\n\n## [${next}] - ${today}`
);

writeFileSync(changelogPath, changelog);

// --- Update package.json ---
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// --- Git commit + tag + push ---
run(`git add package.json CHANGELOG.md`);
run(`git commit -m "chore: release v${next}"`);
run(`git tag -a v${next} -m "v${next}"`);
run(`git push origin main --follow-tags`);

console.log(`\nTagged and pushed v${next}. GitHub Actions will build the .vsix.`);
