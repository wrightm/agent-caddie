#!/usr/bin/env node
// Checks that a pull request description names the issue it belongs to:
// "Part of #N", or a GitHub closing keyword such as "Closes #N".
// See CONTRIBUTING.md, "Linking work".
//
// Usage: PR_BODY="<description>" node scripts/check-linked-issue.mjs
// Tests: node --test scripts/*.test.mjs

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// "Part of", plus every closing keyword GitHub recognises.
const REFERENCE = /\b(part of|close[sd]?|fix(e[sd])?|resolve[sd]?):? #\d+\b/i;

/** True when the description names an issue outside an HTML comment. */
export function namesIssue(body) {
  if (typeof body !== "string") return false;
  // A template placeholder such as <!-- Closes #N --> is not a reference.
  // An unclosed comment hides everything after it, as it does on GitHub.
  const visible = body.replace(/<!--[\s\S]*?(-->|$)/g, "");
  return REFERENCE.test(visible);
}

function main(env) {
  if (namesIssue(env.PR_BODY)) {
    console.log("linked issue: the description names an issue");
    return 0;
  }
  const message =
    'The description names no issue. Add "Part of #N", or "Closes #N" if this pull request ' +
    'finishes the issue. See CONTRIBUTING.md, "Linking work".';
  // The ::error:: prefix makes GitHub Actions show the message as an annotation.
  console.error(env.GITHUB_ACTIONS ? `::error::${message}` : `linked issue: ${message}`);
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.env));
}
