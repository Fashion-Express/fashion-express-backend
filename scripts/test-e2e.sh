#!/usr/bin/env bash
#
# The end-to-end suites, run one file at a time under ts-node.
#
# Three constraints meet here and only this combination satisfies all of them:
#
#   1. better-auth is ESM-only (no CJS build), and Jest decides a module's type
#      from its extension before any transform runs — so a `.mjs` dependency
#      cannot be loaded by its CommonJS registry at all. Jest is out for
#      anything that imports better-auth.
#   2. NestJS needs `emitDecoratorMetadata` for dependency injection *and* for
#      ValidationPipe to know which DTO class a `@Body()` refers to. esbuild
#      (which `tsx` uses) cannot emit it, so validation silently stops working.
#      ts-node emits it.
#   3. `node --test` loads `.ts` files through the ESM loader, which defeats
#      ts-node's CommonJS hook. But `node:test` runs perfectly well when a file
#      is simply *executed*, so each file is run directly instead.
#
# One file at a time, because they share a database: `loadFixture()` truncates
# `users`, and files running concurrently would tear out each other's fixtures.
set -euo pipefail

export NODE_ENV=test

for file in test/e2e/*.test.ts; do
  echo "── ${file}"
  npx ts-node -T "$file"
done
