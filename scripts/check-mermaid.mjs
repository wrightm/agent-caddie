#!/usr/bin/env node
// Renders every ```mermaid block in the repository's Markdown files and
// fails if any block does not parse. GitHub shows an error box in place of
// a diagram it cannot parse, and nothing else in the docs checks notices.
//
// Rendering needs a browser, so this uses the Mermaid CLI through npx, at a
// pinned version. Set CHROME_PATH to use an installed Chrome or Chromium
// instead of the copy Puppeteer downloads (set PUPPETEER_SKIP_DOWNLOAD=true
// as well to skip that download).
//
// Usage: node scripts/check-mermaid.mjs [file.md ...]
// With no arguments, checks every tracked Markdown file.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MERMAID_CLI = "@mermaid-js/mermaid-cli@12.2.0";

/** Returns the mermaid blocks of a Markdown text with their 1-based start line. */
function mermaidBlocks(text) {
  const blocks = [];
  let current = null;
  text.split(/\r?\n/).forEach((line, index) => {
    if (current === null) {
      if (/^\s*```mermaid\s*$/.test(line)) current = { line: index + 1, lines: [] };
    } else if (/^\s*```\s*$/.test(line)) {
      blocks.push({ line: current.line, source: current.lines.join("\n") });
      current = null;
    } else {
      current.lines.push(line);
    }
  });
  return blocks;
}

const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : execFileSync("git", ["ls-files", "-z", "*.md"], { encoding: "utf8" }).split("\0").filter(Boolean);

const diagrams = files.flatMap((file) =>
  mermaidBlocks(readFileSync(file, "utf8")).map((block) => ({ file, ...block })),
);

if (diagrams.length === 0) {
  console.log(`mermaid: no diagrams in ${files.length} file(s), nothing to check`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "check-mermaid-"));
let failures = 0;
try {
  const puppeteerConfig = join(work, "puppeteer.json");
  writeFileSync(
    puppeteerConfig,
    JSON.stringify({
      args: ["--no-sandbox"],
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    }),
  );

  diagrams.forEach((diagram, index) => {
    const input = join(work, `${index}.mmd`);
    writeFileSync(input, `${diagram.source}\n`);
    const result = spawnSync(
      "npx",
      ["--yes", MERMAID_CLI, "--quiet", "-p", puppeteerConfig, "-i", input, "-o", join(work, `${index}.svg`)],
      { encoding: "utf8" },
    );
    if (result.status === 0) return;

    failures += 1;
    const output = `${result.stderr}\n${result.stdout}`;
    const parse = /Parse error on line (\d+):\n(.*)\n(.*)/.exec(output);
    if (parse) {
      // Mermaid counts from the first line inside the fence.
      console.error(`${diagram.file}:${diagram.line + Number(parse[1])}: Mermaid parse error`);
      console.error(`  ${parse[2]}\n  ${parse[3]}`);
    } else {
      const firstLine = output.split("\n").find((line) => line.trim() !== "") ?? "unknown error";
      console.error(`${diagram.file}:${diagram.line}: diagram failed to render: ${firstLine.trim()}`);
    }
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`mermaid: ${failures} of ${diagrams.length} diagram(s) failed in ${files.length} file(s)`);
  process.exit(1);
}
console.log(`mermaid: ${diagrams.length} diagram(s) checked in ${files.length} file(s), all valid`);
