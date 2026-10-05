# MCP

Odometry Scope is both an MCP **client** and an MCP **server**. The server is the more interesting
half: it turns this product into a tool provider for other agents, so an agent can ask "which
sensor lied?" without shelling out.

## Run the server

```bash
node packages/cli/dist/bin.js mcp serve
```

Speaks MCP over **stdio**. Once it starts, stdout belongs to the protocol — all diagnostics go to
stderr. The command does not return; it is meant to be spawned by a client.

If the CLI package is installed as a dependency, the command is simply `odoscope mcp serve`.

## Point a client at it

Because `npm install` does not link this leaf workspace package into `node_modules/.bin`, use an
absolute path to the built entry point:

```json
{
  "mcpServers": {
    "odometry-scope": {
      "command": "node",
      "args": ["/absolute/path/to/odometry-scope/packages/cli/dist/bin.js", "mcp", "serve"]
    }
  }
}
```

Run `npm run build` first — the server is loaded from `packages/cli/dist/`, not from source.

## The ten tools

Every tool is derived from the core registry by `describeTools()`. There is no second list to keep
in sync, so a tool cannot drift between the registry and the protocol surface. Names must match
`^[a-z][a-z0-9_]{0,63}$`; a name that cannot is rejected at startup rather than silently renamed.

### The product question

| Tool          | What it is for                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyze_run` | **The flagship.** One run document in; summary, per-step drift envelope, sensor-by-sensor ablation and a bounded verdict out. Use this rather than chaining the `engine_*` tools by hand, so the verdict always includes the attribution. |

### The engine operations

Each is a thin, validated wrapper over one pure Python function. Use them when you are building up
a report yourself, or when you want one step in isolation.

| Tool                | What it is for                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `engine_normalize`  | Canonicalise a raw sample log into typed channels. Accepts aliases (`yaw` for `theta`, `time` for `t`), sorts by time, reports rate and duration. Call this first so nothing downstream depends on field naming.                                 |
| `engine_integrate`  | Dead-reckon a pose from a rate series with RK4 and step-doubling error control. Returns the pose plus the integrator's own truncation error.                                                                                                     |
| `engine_divergence` | Measure drift from a reference track against a propagated envelope built from the uncertainty you state. Returns per-step observed-versus-bound, the first exceedance and the worst ratio. `params.strict` turns an escaped bound into an error. |
| `engine_attribute`  | **Find which sensor is lying.** Ablate one sensor, renormalise the remaining fusion weights, re-integrate, report how much drift it explained. A sensor returns `primary`, `contributing`, `negligible`, `masking`, or `sole-source`.            |
| `engine_classify`   | Turn an envelope plus an attribution into a verdict: `ok`/`watch`/`drifting`, and whether it is still `certified` or already `unbounded`. Use last, so a report always says whether it is standing on proven ground.                             |
| `engine_summarize`  | Reduce a run to the numbers an operator reads first: count, duration, rate, path length, mean and peak speed, peak yaw rate, terminal pose.                                                                                                      |

### Introspection

| Tool           | What it is for                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health_check` | Report whether this installation can do the work: Node version, engine reachability, registry size, skills, plugins. Use first when a tool call fails, to tell a broken environment from a broken input. |
| `list_skills`  | The skill catalog with each skill's name, version and description. Pass `includeBodies` for the bodies too.                                                                                              |
| `list_plugins` | The resolved plugin registry, including shadowed, disabled and rejected plugins and why — this is how you explain a missing capability.                                                                  |

Permissions are declared per tool and enforced before the handler runs. The six `engine_*` tools
and `analyze_run` declare `proc:spawn`, because spawning the Python engine is precisely what they
do. `list_skills` and `list_plugins` declare `fs:read`.

## The stdio proof

`packages/mcp/src/stdio-proof.ts` is a real MCP client driving the real server over real stdio. It
performs the handshake, lists the tools, calls `analyze_run` on the `wheel-scale-drift` run —
which reaches the Python engine — asserts the wheel is named, then calls a tool with deliberately
invalid input to prove the error envelope survives the round trip.

```bash
node packages/mcp/dist/stdio-proof.js
```

```console
connecting to `odoscope mcp serve` over stdio
handshake                  initialize + initialized complete
server                     odometry-scope v0.1.0
tools/list                 10 tools: analyze_run, engine_attribute, engine_classify, engine_divergence, engine_integrate, engine_normalize, engine_summarize, health_check, list_plugins, list_skills
tools/call analyze_run     drifting / unbounded
  peak observed            0.2818 m
  certified bound          0.0111 m
  ablation imu             masking (-23.4%)
  ablation lidar           masking (-40.1%)
  ablation wheel           primary (96.0%)
tools/call invalid         isError=true · VALIDATION_FAILED: "estimate" must be an object

MCP stdio proof passed.
```

It exits `0` on success and `1` on any failed assertion — including if `analyze_run` ever stops
naming the wheel for that run, which makes it a product-claim test rather than only a protocol
test.

## Errors

Failures come back as an MCP error envelope carrying the stable code, so a client can branch on it
rather than parse prose:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "VALIDATION_FAILED: \"estimate\" must be an object" }]
}
```

Codes come from one closed taxonomy: `VALIDATION_FAILED`, `PERMISSION_DENIED`, `NOT_FOUND`,
`CONFLICT`, `UPSTREAM_FAILED`, `TIMEOUT`, `UNSUPPORTED`. An engine failure keeps the engine's own
code visible inside `UPSTREAM_FAILED`, because `BOUND_VIOLATION` is the result this product exists
to report and must not be flattened away.

## Rules

1. **A new model-facing CLI command must also ship as an MCP tool.** If an agent can do it from
   the terminal, another agent must be able to do it over MCP.
2. **MCP tools are stateless.** No session state spans calls.
3. **Names must match `^[a-z][a-z0-9_]{0,63}$`.** The server refuses to start rather than renaming
   silently, and names the offending tool.
4. **Descriptions are written for a model.** Say what the tool does, when to use it, and what it
   returns. The descriptions in this repository are the specification — `packages/mcp` reads them
   from the registry rather than restating them.
5. **Never put a model call in the numeric path.** An MCP client may summarise a verdict. It may
   not compute one.
