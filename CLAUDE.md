# RISK Bot — working rules

Read DESIGN.md before writing code. It is the spec. Where you
disagree with it on a Discord or Google API detail, the doc is
probably right — those were verified.

## Hard constraints
- The Worker runs on Cloudflare, NOT Node. Never import `googleapis`
  or any Node-only library into src/worker or src/lib. Write the
  Sheets/Calendar client on fetch + WebCrypto (RS256 JWT -> token
  exchange), so the same code runs in the Actions jobs too.
- All Sheets access goes through src/lib/sheets.ts. No scattered
  API calls anywhere else.
- Register GUILD commands, never global ones.
- Every feature flag defaults to OFF.
- Never put a secret in a file, a shell command, or a commit.
  If a step needs one, stop and tell me to do it myself.

## Scope
Build one rank at a time. Do not build ahead. If a task seems to
need a feature from a later rank, stop and say so instead of
building it.
