# Governance

## Roles

| Role            | Responsibility                                            |
| --------------- | --------------------------------------------------------- |
| **Contributor** | anyone who opens an issue or PR                           |
| **Maintainer**  | reviews changes, merges, cuts releases                    |
| **Owner**       | aniruddhaadak80 — final decision, security response, BDFL |

## How decisions are made

1. **Anything with a footprint gets an ADR.** If a change moves capability between the
   footprint ladder rungs, or crosses a package boundary, it needs a record in `docs/adr/`.
2. **Discussion happens in the issue**, before code. For anything beyond a trivial fix.
3. **Consensus, then the maintainer decides.** If threads converge, merge. If they do not, the
   maintainer decides and writes down why in the closing comment.
4. **A maintainer may decline** any change, for any reason, and owes a clear explanation.

## Merging

- Requires `npm run check` green.
- Requires one review from someone other than the author.
- Requires the PR's `**Goal:**` line to match what the change actually does. If it has drifted,
  the Goal line is edited first.
- Squash-merge, conventional commit subject.

## Releases

The release workflow owns every version bump. No PR edits a version. Tags are cut only on a
green build.

## Changing this document

By the same process as changing the product. Governance that can be changed without
discussion is not governance.
