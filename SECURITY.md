# Security policy

agent-caddie is pre-alpha. There is no released version yet, so there is
nothing to patch or backport: fixes land on `main`. This policy will gain a
supported-versions table with the first release.

## Reporting a vulnerability

Please report privately through GitHub:
[open a private security advisory](https://github.com/wrightm/agent-caddie/security/advisories/new).

Do not open a public issue, discussion or pull request for a suspected
vulnerability.

A useful report says:

- what you found and where (file, command or document section);
- how to reproduce it, or why you believe it is exploitable;
- what an attacker gains, and what they need to already have;
- the commit you tested against.

## What to expect

The project has a single maintainer, so responses are best effort. The aim
is to acknowledge a report within seven days, agree a fix and a disclosure
date with you, and credit you in the advisory unless you prefer otherwise.

## What counts

Caddie runs on the user's machine, inside their coding-agent harness, with
their privileges, and it reads session transcripts. Reports in these areas
are especially welcome:

- **Privacy**: prompt text, file contents or secrets being stored, logged or
  included in a bundle when the design says they are redacted.
- **Network**: any network call from a build that is meant to be local-only.
- **Code execution**: a transcript, knowledge pack, rule or configuration
  file causing Caddie to run code or commands the user did not ask for.
- **Tampering**: a knowledge pack or rule changing Caddie's advice or
  behaviour without the provenance being visible in reports.
- **Supply chain**: weaknesses in the build, the committed bundle or the
  release and CI workflows.

A design document that describes behaviour with one of these problems is
also worth reporting, even before any code exists.

## Out of scope

- Vulnerabilities in a harness itself (Claude Code, Gemini CLI and others).
  Report those to the vendor.
- Anything that requires an attacker who already controls the user's
  account or machine, unless Caddie makes the outcome meaningfully worse.
