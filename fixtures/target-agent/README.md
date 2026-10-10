# Target support agent fixture

This tiny repository is the executable target for TraceHealer's deterministic end-to-end flow. The checked-in implementation intentionally models the stale Order API v2 contract.

- `npm test` fails before healing.
- TraceHealer copies the repository into an isolated workspace.
- It reproduces the production failure, applies the generated full-file patch, reruns the same input and all tests, and creates a local git commit/proposal artifact.
- The source fixture itself is never modified.
