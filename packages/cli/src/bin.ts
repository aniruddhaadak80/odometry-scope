#!/usr/bin/env node
import { buildProgram } from './program.js'

/**
 * Exit codes are part of the contract: 0 ok, 1 runtime failure, 2 usage error.
 *
 * `exitOverride` makes commander throw for --help and --version instead of calling
 * process.exit, so those paths arrive here too. They already carry exit code 0 and must
 * keep it — overwriting 0 with 1 makes `--help` look like a failure in CI and to any
 * script that probes the binary.
 */
buildProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    if (process.exitCode === 0 || process.exitCode === 2) return
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`error: ${message}\n`)
    process.exitCode = 1
  })
