# CLI reference

The binary is `odoscope` (declared as `bin` in `packages/cli/package.json`). It is a leaf
workspace package, so `npm install` does **not** link it into `node_modules/.bin`. In a clone,
invoke it through its built entry point:

```bash
node packages/cli/dist/bin.js <command> [options]
```

Every example below is written that way. If you have installed the CLI package as a dependency,
`odoscope <command>` is the same program.

## Exit codes

These are part of the contract, not an implementation detail.

| Code | Meaning                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                           |
| `1`  | runtime failure — a `doctor` check failed, a tool returned an error, `--strict` caught an escaped bound, or an engine call failed |
| `2`  | usage error — unknown command or flag, unreadable run file, or `mcp call` given input that is not valid JSON                      |

`--strict` is the interesting case: the analysis _succeeded_ and the drift is real, so the exit
code is deliberately `1` rather than `0`.

## Commands

| Command                             | Purpose                                                             |
| ----------------------------------- | ------------------------------------------------------------------- |
| `odoscope doctor [--json]`          | probe every subsystem; print a status and a fix hint per row        |
| `odoscope tools [--json]`           | list the registered tools — the authoritative capability list       |
| `odoscope run <file> [options]`     | analyse a run; print the envelope strip, ablation table and verdict |
| `odoscope version`                  | version and runtime information as JSON                             |
| `odoscope mcp serve`                | run the MCP server over stdio                                       |
| `odoscope mcp call <tool> '<json>'` | invoke one tool directly, without an MCP protocol round trip        |

There is no `skills` or `plugins` subcommand. To read the skill catalog, call the tool:

```bash
node packages/cli/dist/bin.js mcp call list_skills '{}'
```

## `doctor`

Probes the runtime, the package, the skill catalog, the plugin registry, the config, the Python
engine and the committed sample runs.

```bash
node packages/cli/dist/bin.js doctor
```

```console
odometry-scope doctor
  [PASS] node           v22.23.2
  [PASS] package        odometry-scope@0.1.0
  [PASS] skills         4 skills, 0 invalid
  [PASS] plugins        3 active, 0 disabled
  [WARN] config         no product.config.json — using defaults
         fix: run with defaults, or create product.config.json
  [PASS] python engine  reachable, 2-sample probe ok
  [PASS] sample runs    3 analysed runs committed

all required checks passed
```

`doctor` never throws. A failing subsystem becomes a row with a status, a detail and a **fix**
hint. The exit code is `1` only if a `fail` row exists; a `warn` row still exits `0`, so `doctor`
works as a CI smoke test without taking the build down over an absent optional file.

The engine row is produced by **actually calling the engine** with a two-sample probe, not by
checking that a file exists. A tree with healthy Node and an unreachable Python passes every other
row and still cannot answer a question.

`--json` emits the same report as a document:

```bash
node packages/cli/dist/bin.js doctor --json
```

## `tools`

Lists every registered tool with its surface and description.

```bash
node packages/cli/dist/bin.js tools
node packages/cli/dist/bin.js tools --json
```

The JSON form adds each tool's `inputSchema`, declared `permissions`, `surface` and `source`, and
is the authoritative machine-readable capability list.

## `run`

The flagship command. Takes the path to a run document.

```bash
node packages/cli/dist/bin.js run <file> [--json] [--strict] [--max-steps <n>]
```

| Option            | Effect                                                                          |
| ----------------- | ------------------------------------------------------------------------------- |
| `--json`          | print the whole `RunAnalysis` as one JSON document instead of the report        |
| `--strict`        | exit `1` when drift escapes the certified envelope, and raise `BOUND_VIOLATION` |
| `--max-steps <n>` | the cap on reported envelope steps (default `4096`)                             |

The human report has three parts: the **drift envelope** strip, the **sensor ablation** table, and
the **verdict**. See the top-level README for a full worked example with real output.

`--strict` output is the product's refusal to quote a confidence the numerics did not earn:

```bash
node packages/cli/dist/bin.js run apps/web/data/runs/wheel-scale-drift.json --strict
```

```console
BOUND_VIOLATION (surfaced as UPSTREAM_FAILED): observed drift escaped the certified envelope at step 1 (t=0.050000s, observed=0.281786m, bound=0.011147m); the drift is real and unbounded by the stated sensor assumptions
```

The engine's own code is shown alongside the product-level one on purpose. Losing
`BOUND_VIOLATION` behind a generic `UPSTREAM_FAILED` would hide the one result this product exists
to report.

### Exit codes for `run`

| Situation                                            | Exit |
| ---------------------------------------------------- | ---- |
| run analysed, drift inside the envelope              | `0`  |
| run analysed, drift escaped, without `--strict`      | `0`  |
| run analysed, drift escaped, with `--strict`         | `1`  |
| file unreadable or not valid JSON                    | `2`  |
| the file is not a run document (`VALIDATION_FAILED`) | `1`  |
| engine unreachable                                   | `1`  |

Note the second row: by default an escaped bound is a **reported result**, not a failure. Use
`--strict` when you want drift to break a pipeline.

## `version`

```bash
node packages/cli/dist/bin.js version
```

```console
{
  "name": "odometry-scope",
  "version": "0.1.0",
  "node": "22.23.2",
  "platform": "win32",
  "tools": 10
}
```

`tools` is read from the live registry, so it is a real count rather than a constant. The `-v` /
`--version` flags print the bare version.

## `mcp serve`

Runs the MCP server over stdio. From that point stdout belongs to the protocol, so all
diagnostics are written to stderr. This command does not return; it is meant to be spawned by an
MCP client.

```bash
node packages/cli/dist/bin.js mcp serve
```

Client configuration is in [mcp.md](mcp.md).

## `mcp call`

Invokes one tool directly, without a protocol round trip. Useful for exploration and for scripting
against the registry in a way that keeps the exit-code contract.

```bash
node packages/cli/dist/bin.js mcp call <tool> '<json>'
```

```bash
node packages/cli/dist/bin.js mcp call engine_summarize '{"channels":{"t":[0,0.5,1.0],"v":[0.5,0.6,0.5]}}'
```

```console
{
  "count": 3,
  "durationS": 1,
  "rateHz": 2,
  "pathLength": 0,
  "meanSpeed": 0.5333333333333333,
  "maxSpeed": 0.6,
  "maxYawRate": 0,
  "terminalPose": {
    "x": 0,
    "y": 0,
    "theta": 0
  },
  "maxLocalError": 0,
  "issues": [
    "no position columns; reported rates only"
  ]
}
```

Input that is not valid JSON exits `2`; a tool that returns an error exits `1` with the code on
stderr.

```console
$ node packages/cli/dist/bin.js mcp call no_such_tool '{}'
CONFLICT: tool "no_such_tool" is not registered
$ echo $?
1
```

```console
$ node packages/cli/dist/bin.js run apps/web/data/runs/does-not-exist.json
error: cannot read run file apps/web/data/runs/does-not-exist.json — Error: ENOENT: no such file or directory
$ echo $?
2
```

### Quoting on Windows

Node's argument parser on Windows strips unescaped double quotes, so the POSIX single-quoted form
above reaches the program mangled as `{channels:{t:...}}`. On PowerShell 5.1, escape the inner
quotes:

```bash
node packages/cli/dist/bin.js mcp call engine_summarize '{\"channels\":{\"t\":[0,0.5,1.0],\"v\":[0.5,0.6,0.5]}}'
```

Both forms deliver the identical argument and produce the identical output shown above.

## Machine-readable output

`doctor`, `tools` and `run` all accept `--json`. Results go to stdout and diagnostics to stderr, so
`--json` output is always safe to pipe into a parser. `version` and `mcp call` are already JSON on
stdout.
