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
// Tests: node --test scripts/*.test.mjs

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

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

/** Returns the front-matter fields, or null when the text has no front matter. */
export function parseFrontMatter(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
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

/**
 * Returns the problems with one document. `path` is relative to the docs
 * directory and uses forward slashes, for example "specs/2026-01-02-x.md".
 */
export function checkDocument(path, text) {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  if (name === "README.md" || parts[0] === "adr") return [];

  const kind = parts[0] === "specs" ? "spec" : "living";
  const schema = SCHEMAS[kind];
  const errors = [];

  if (kind === "spec" && !SPEC_FILENAME.test(name)) {
    errors.push("spec filename must be YYYY-MM-DD-<topic>.md");
  }

  const fields = parseFrontMatter(text);
  if (fields === null) return [...errors, "missing front matter (file must start with a --- block)"];

  for (const key of schema.required) {
    if (!fields[key]) errors.push(`missing or empty field "${key}"`);
  }
  if (fields.status && !schema.statuses.includes(fields.status)) {
    errors.push(`status "${fields.status}" must be one of: ${schema.statuses.join(", ")}`);
  }
  for (const key of schema.dates) {
    if (fields[key] && !isIsoDate(fields[key])) {
      errors.push(`"${key}" must be an ISO date (YYYY-MM-DD), got "${fields[key]}"`);
    }
  }
  if (kind === "spec" && fields.date && !name.startsWith(fields.date)) {
    errors.push(`"date" (${fields.date}) must match the date in the filename`);
  }
  return errors;
}

function main(docsDir) {
  let files;
  try {
    files = markdownFiles(docsDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log(`front matter: no ${docsDir}/ directory, nothing to check`);
    return 0;
  }

  let failures = 0;
  for (const file of files.sort()) {
    const path = relative(docsDir, file).split(sep).join("/");
    for (const message of checkDocument(path, readFileSync(file, "utf8"))) {
      console.error(`${file}: ${message}`);
      failures += 1;
    }
  }

  if (failures > 0) {
    console.error(`front matter: ${failures} problem(s) in ${files.length} file(s)`);
    return 1;
  }
  console.log(`front matter: ${files.length} file(s) checked, all valid`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv[2] ?? "docs"));
}
