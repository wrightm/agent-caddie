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
//
// Tests: node --test scripts/*.test.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MERMAID_CLI = "@mermaid-js/mermaid-cli@12.2.0";

const OPENING_FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * Returns the mermaid blocks of a Markdown text. `line` is the 1-based line
 * of the opening fence. Every fenced block is tracked, so a mermaid example
 * quoted inside a longer fence is not mistaken for a diagram. A fence that
 * is never closed runs to the end of the text, as it does when Markdown is
 * rendered.
 */
export function mermaidBlocks(text) {
  const blocks = [];
  let current = null;
  const finish = () => {
    if (current.language === "mermaid") blocks.push({ line: current.line, source: current.lines.join("\n") });
    current = null;
  };
  text.split(/\r?\n/).forEach((line, index) => {
    if (current === null) {
      const opening = OPENING_FENCE.exec(line);
      if (opening) current = { line: index + 1, fence: opening[1], language: opening[2], lines: [] };
      return;
    }
    const closing = CLOSING_FENCE.exec(line);
    if (closing && closing[1][0] === current.fence[0] && closing[1].length >= current.fence.length) {
      finish();
    } else {
      current.lines.push(line);
    }
  });
  if (current !== null) finish();
  return blocks;
}

/**
 * Turns the output of a failed render into the lines to print. A parse
 * error is reported at its line in the Markdown file; anything else at the
 * opening fence.
 */
export function describeFailure(diagram, output) {
  const parse = /Parse error on line (\d+):\r?\n(.*)\r?\n(.*)/.exec(output);
  if (parse) {
    // Mermaid counts from the first line inside the fence.
    return [
      `${diagram.file}:${diagram.line + Number(parse[1])}: Mermaid parse error`,
      `  ${parse[2]}`,
      `  ${parse[3]}`,
    ];
  }
  const firstLine = output.split(/\r?\n/).find((line) => line.trim() !== "") ?? "unknown error";
  return [`${diagram.file}:${diagram.line}: diagram failed to render: ${firstLine.trim()}`];
}

/**
 * Checks every diagram in the given files.
 * `read(file)` returns the file's text. `render(source)` returns
 * `{ ok, output }`. Both are parameters so the logic can be tested without
 * a file system or a browser.
 */
export function checkFiles(files, { read, render }) {
  const diagrams = files.flatMap((file) => mermaidBlocks(read(file)).map((block) => ({ file, ...block })));
  const errors = [];
  let failed = 0;
  for (const diagram of diagrams) {
    const result = render(diagram.source);
    if (result.ok) continue;
    failed += 1;
    errors.push(...describeFailure(diagram, result.output));
  }
  return { fileCount: files.length, diagramCount: diagrams.length, failed, errors };
}

/** Returns the summary line and exit code for a result of `checkFiles`. */
export function summarise({ fileCount, diagramCount, failed }) {
  if (diagramCount === 0) {
    return { exitCode: 0, message: `mermaid: no diagrams in ${fileCount} file(s), nothing to check` };
  }
  if (failed > 0) {
    return {
      exitCode: 1,
      message: `mermaid: ${failed} of ${diagramCount} diagram(s) failed in ${fileCount} file(s)`,
    };
  }
  return {
    exitCode: 0,
    message: `mermaid: ${diagramCount} diagram(s) checked in ${fileCount} file(s), all valid`,
  };
}

/** Returns a `render` function backed by the Mermaid CLI, working in `dir`. */
export function cliRenderer(dir, env = process.env) {
  const puppeteerConfig = join(dir, "puppeteer.json");
  writeFileSync(
    puppeteerConfig,
    JSON.stringify({
      args: ["--no-sandbox"],
      ...(env.CHROME_PATH ? { executablePath: env.CHROME_PATH } : {}),
    }),
  );
  let count = 0;
  return (source) => {
    count += 1;
    const input = join(dir, `${count}.mmd`);
    writeFileSync(input, `${source}\n`);
    const result = spawnSync(
      "npx",
      ["--yes", MERMAID_CLI, "--quiet", "-p", puppeteerConfig, "-i", input, "-o", join(dir, `${count}.svg`)],
      { encoding: "utf8", env },
    );
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
    return { ok: result.status === 0, output };
  };
}

function main(args) {
  const files =
    args.length > 0
      ? args
      : execFileSync("git", ["ls-files", "-z", "*.md"], { encoding: "utf8" }).split("\0").filter(Boolean);

  const dir = mkdtempSync(join(tmpdir(), "check-mermaid-"));
  let result;
  try {
    result = checkFiles(files, { read: (file) => readFileSync(file, "utf8"), render: cliRenderer(dir) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const line of result.errors) console.error(line);
  const { exitCode, message } = summarise(result);
  (exitCode === 0 ? console.log : console.error)(message);
  return exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
