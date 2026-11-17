# spec

TLA+ models of the behavior people rely on, checked by TLC, the TLA+ model checker.

- `X.tla` with `X.cfg` is a model. TLC must find no error in it.
- `broken/Y.tla` with `broken/Y.cfg` is a copy of a model with one protection removed. TLC must catch it breaking the invariant listed for it in `broken/EXPECTED.json`:

  ```json
  { "Y": { "invariant": "<name>", "because": "<plain sentence>" } }
  ```

A broken variant that passes, breaks a different invariant, or cannot be read fails the check: it means the model would not catch the mistake it was written to catch. Every spec directory needs at least one model and one broken variant.

`Sample` is the starting example: a count that must never go past `Capacity`. `broken/SampleNoGuard` drops the "is there room" test from `Add`, and TLC shows the count reaching `Capacity + 1`. Replace both with your own models.

## Run it

```text
mise trust && mise install
npm run tlc
```

[mise](https://mise.jdx.dev) installs the Java version pinned in `.mise.toml`. The same file pins `tla2tools.jar` (TLC) by exact address and SHA-256; `scripts/tla2tools.mjs` downloads it once into a cache directory and refuses a file whose hash differs. `npm run tlc` runs `tlc -workers 1 -config X.cfg X.tla` for every `.cfg` and ends with a table of what each model had to do and did.
