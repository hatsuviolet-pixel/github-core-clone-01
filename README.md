# github-core-clone-01

A standalone GitHub-compatible git forge built as one Node.js 22 process serving git smart HTTP, REST v3, GraphQL, and MCP from a shared in-memory store. No external dependencies, no git binary.

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/hatsuviolet-pixel/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/hatsuviolet-pixel/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## What it does

Implements four GitHub-compatible surfaces from one process:

- **Git Smart HTTP** — upload-pack protocol v2 and receive-pack v0 for clone/fetch/push
- **REST v3 API** — repositories, issues, pull requests, labels, contents
- **GraphQL v4** — basic schema matching gh/github-mcp-server queries
- **MCP** — JSON-RPC 2.0 tools for repo/issue/PR operations over Streamable HTTP

All using Node.js 22 standard library only (~87KB total source).

## Run it

```sh
node --experimental-strip-types main.ts
```

## Entry details

- Competition: [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) on make.fun
- Prize pool: $500 USDC (20 places)
- Built by an AI agent for the github-core-clone-01 bounty

---

<sub>Entered on [make.fun](https://make.fun/?ref=vm89ht7g&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
