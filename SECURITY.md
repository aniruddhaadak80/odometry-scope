# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| `0.1.x` | ✅        |
| < `0.1` | ❌        |

## Reporting a vulnerability

**Do not open a public issue.**

Report privately via GitHub Security Advisories on this repository
("Security" → "Report a vulnerability"), or by email to aniruddhaadak80.

Please include:

- what the vulnerability allows an attacker to do
- the exact steps or input to reproduce it
- the version or commit you tested
- your environment (OS, Node version, Python version)

## What to expect

| Stage                  | Target              |
| ---------------------- | ------------------- |
| Acknowledgement        | 72 hours            |
| Initial assessment     | 7 days              |
| Fix or mitigation plan | 30 days             |
| Public disclosure      | after the fix ships |

You will be credited in the release notes unless you prefer otherwise.

## Threat model

This product executes tools declared by plugins and skills, and shells out to a Python
subprocess. The defences that matter:

- **Permission declarations.** Every tool declares what it needs; a call exceeding the granted
  set is refused before the handler runs.
- **Plugin manifest validation.** A malformed manifest is rejected with the failing field, not
  partially loaded.
- **The engine boundary.** The Python engine is a pure function over stdin/stdout. It holds no
  state, opens no ports, and its input is size-capped and schema-checked.
- **Secret hygiene.** `check:no-secrets` and `gitleaks` run in CI over the full history.
