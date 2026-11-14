#!/usr/bin/env node
// Validates the YAML front matter of every Markdown file under docs/.
//
// Two kinds of document exist and must not be confused:
//   - point-in-time records: docs/specs/YYYY-MM-DD-<topic>.md
//   - living documents: everything else under docs/
// README.md files are maps and are exempt. docs/adr/ is skipped until the
// ADR template lands (Phase 3), when its schema is added here.
//
// Zero dependencies on purpose: front matter in this repo is flat
// `key: value` lines, so no YAML parser is needed.
//
// Usage: node scripts/check-front-matter.mjs [docs-dir]

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SPEC_FILENAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;
const SPEC_STATUSES = ["draft", "approved", "implemented", "superseded"];

const SCHEMAS = {
  spec: {
    required: ["title", "status", "date", "authors", "supersedes", "superseded-by", "living-docs"],
    statuses: SPEC_STATUSES,
    dates: ["date"],
  },
  living: {
    required: ["title", "status", "last-verified", "owner", "depends-on-adrs"],
    statuses: ["living"],
    dates: ["last-verified"],
  },
};

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

/** Returns the front-matter fields, or null when the file has no front matter. */
function parseFrontMatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

function check(file, docsDir) {
  const parts = relative(docsDir, file).split(sep);
  const name = basename(file);
  if (name === "README.md" || parts[0] === "adr") return [];

  const kind = parts[0] === "specs" ? "spec" : "living";
  const schema = SCHEMAS[kind];
  const errors = [];

  if (kind === "spec" && !SPEC_FILENAME.test(name)) {
    errors.push("spec filename must be YYYY-MM-DD-<topic>.md");
  }

  const fields = parseFrontMatter(readFileSync(file, "utf8"));
  if (fields === null) return [...errors, "missing front matter (file must start with a --- block)"];

  for (const key of schema.required) {
    if (!fields[key]) errors.push(`missing or empty field "${key}"`);
  }
  if (fields.status && !schema.statuses.includes(fields.status)) {
    errors.push(`status "${fields.status}" must be one of: ${schema.statuses.join(", ")}`);
  }
  for (const key of schema.dates) {
    if (fields[key] && !ISO_DATE.test(fields[key])) {
      errors.push(`"${key}" must be an ISO date (YYYY-MM-DD), got "${fields[key]}"`);
    }
  }
  if (kind === "spec" && fields.date && !name.startsWith(fields.date)) {
    errors.push(`"date" (${fields.date}) must match the date in the filename`);
  }
  return errors;
}

const docsDir = process.argv[2] ?? "docs";
let files;
try {
  files = markdownFiles(docsDir);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.log(`front matter: no ${docsDir}/ directory, nothing to check`);
  process.exit(0);
}

let failures = 0;
for (const file of files.sort()) {
  for (const message of check(file, docsDir)) {
    console.error(`${file}: ${message}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`front matter: ${failures} problem(s) in ${files.length} file(s)`);
  process.exit(1);
}
console.log(`front matter: ${files.length} file(s) checked, all valid`);
