# Tenets

Short, checkable principles. A change that violates one of these needs a better argument than
taste.

1. **One waist.** Every capability is a Tool in one registry. A second code path is a bug even
   when it works.
2. **Deterministic where it matters.** Anything that must be exactly right is code, not a
   model call. If you cannot test it, it is not deterministic yet.
3. **Report, never silently skip.** A skill that fails to load, a plugin that is rejected, a
   tool that is shadowed — all reported. Silent failure is how a product becomes unexplainable.
4. **Ratchet, do not crusade.** Lint debt is baselined and frozen. Fixing debt is good;
   requiring it in an unrelated PR is not.
5. **Admit what you did not do.** An omitted surface with a stated reason is a design
   decision. An omitted surface with no explanation is a gap.
6. **Evidence before assertion.** "It works" is a claim. A command and its output is proof.
7. **Fail with a fix.** An error that names the remedy is a feature. One that names only the
   problem is a support ticket waiting to happen.
8. **The engine is pure.** No clock, no network, no randomness. Time and entropy are
   arguments.
9. **Documentation is a deliverable.** A change nobody can discover is not finished.
10. **Version is the release's job.** No PR edits a version. One source of truth, no merge
    conflicts about it.
