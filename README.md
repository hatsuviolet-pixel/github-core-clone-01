# github-core-clone-01

A GitHub-compatible git forge built for make.fun's "Build a GitHub-compatible git forge" bounty.

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)

## What it does

Implements a standalone GitHub-compatible forge serving four surfaces from one process:

- **Git Smart HTTP** — upload-pack (protocol v2) and receive-pack (v0) for clone/fetch/push
- **REST v3 API** — repositories, issues, pull requests, labels, contents
- **GraphQL v4** — basic schema matching gh/github-mcp-server queries
- **MCP** — JSON-RPC 2.0 tools for repo/issue/PR operations

Built with Node.js 22 standard library only — no external dependencies, no git binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

## Score

Practice trial score: pending grading

