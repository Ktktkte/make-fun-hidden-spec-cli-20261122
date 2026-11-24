# mend

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Bounty: [hidden-spec-cli-01-run-20261122 on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write, in four formats, to a tree of text
files: unified diffs, SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. `SPEC.md` is the
whole specification: the command line, the output and exit codes, safe paths, format detection, matching lines
at three tiers (exact, trailing-whitespace, indentation-insensitive), and the all-or-nothing write — every file
is changed or nothing is.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. When
  `MAKEFUN_ENV_URL` is set it hands the trial over to `runner.ts` instead.
- `runner.ts`: the trial runner; in a trial it reads the checks from the env, runs `node main.ts` on each one
  in a fresh directory, and posts what main.ts did.
- `check.ts`: runs the practice set (`program/generator/practice.json` in the kit) against `main.ts` locally.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
