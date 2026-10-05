# Contributing

## Setup

```bash
git clone https://github.com/aniruddhaadak80/odometry-scope.git
cd odometry-scope
npm install
odoscope doctor
```

## The loop

1. Open an issue first for anything beyond a trivial fix. The discussion is the point.
2. Branch: `feat/`, `fix/`, `docs/`, `chore/`.
3. Conventional commits. One type per commit.
4. `npm run check` must exit 0.
5. Open a PR with a frozen `**Goal:**` line as the first line of the description.

## The pre-push gate

```bash
npm run check
```

This runs the exact command CI runs, so local and CI cannot drift. If it passes locally it
will pass in CI.

## Adding capability

Read the **footprint ladder** in `AGENTS.md` before you write code, and read
[`docs/notes/adding-a-tool.md`](docs/notes/adding-a-tool.md). Reaching for
`packages/core` first is the most common review comment on this project.

## Style

```bash
npm run format        # prettier
npm run lint          # eslint
npm run typecheck     # tsc --noEmit across every package
npm run pytest        # the Python engine
```

## Tests

Every change needs a test that would fail without it. Cover the failure path — a test that only
exercises the happy path is not a test, it is a smoke signal.

## Commit messages

```
feat: add diff operation to the engine
fix(core): reject duplicate tool names at registration
docs: document the footprint ladder
chore(deps): bump playwright to 1.62
test(engine): property test for order-independent normalise
```

## License

By contributing you agree that your contribution is licensed under the MIT License.
