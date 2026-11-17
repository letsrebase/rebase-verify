# Security policy

work-profile processes freelancers' local Claude Code logs and produces a profile that
may be sent to rebase for review. That makes two things security-sensitive:
the redaction/privacy pipeline on the candidate's machine, and the rebase hub's
sign-in and intake endpoints that receive submissions.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: [GitHub private vulnerability reporting](https://github.com/letsrebase/work-profile/security/advisories/new)
  (Security tab → Report a vulnerability).
- Or email **ciao@letsrebase.com** with subject `SECURITY: work-profile`.

We acknowledge within **5 working days** and keep you updated until resolution.
Credit in the fix's release notes is yours if you want it.

## What counts (examples)

- Any path where candidate data leaves the machine without explicit consent
  (bypass of the redaction pipeline, the repoLabel strip, or the submit gate).
- PII surviving redaction into `candidate.json` or the narrative input.
- Log-parsing vulnerabilities (the tool parses untrusted JSONL from disk).
- Intake or sign-in issues on the rebase hub (injection, auth bypass, a sign-in token
  that can be reused or guessed). Report these the same way; they are fixed on the hub.
- Anything that lets a profile claim verification it didn't earn (tampering with
  the authenticity/groundedness mechanisms counts — they're trust surfaces).

## Supported versions

The `main` branch. The tool is run from a fresh clone by design, so fixes land on
`main` and there are no maintained release lines.
