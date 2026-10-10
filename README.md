# pi-fold-compact

A [Pi](https://github.com/earendil-works/pi) compaction backend that folds compacted history instead of summarizing it.

Pi, or any extension that calls `ctx.compact()`, still decides when to compact and where to cut. When a compaction runs, this extension takes it over. Manual, threshold and overflow compactions are all handled, and no model is called. The history before Pi's cut point is folded with the span selection, deterministic briefs and consolidation of [pi-fold](https://www.npmjs.com/package/pi-fold) 4.2.8, which is vendored unchanged in `src/vendor/pi-fold`.

## What the model sees

Before each model call, Pi's compaction summary message is replaced by pi-fold's own fold placeholders, one custom message per root fold:

```
[pi-fold active-context fold fold_…]
<deterministic brief>
Topology: kind=chapter; parent=root; children=0; previous=none; next=fold_….
Expand exactly: pi_fold_context {"action":"expand","id":"fold_…"}
List/page exactly: pi_fold_context {"action":"status"}
```

The projection is deterministic, so the folded prefix stays cache-stable between calls. A span pi-fold would not fold yet stays verbatim. When an earlier compaction was written by another backend, its summary is kept as the first message and only the history after it is folded. Later compactions carry the existing folds forward and fold the newly compacted history after them.

## Recovering folded history

The `pi_fold_context` tool exposes pi-fold's read actions:

- `status` lists root folds and pages through the fold index.
- `peek` returns a fold's exact source from the session file. By default the result is ephemeral and is withdrawn once the model has replied.
- `expand` restores a fold's original messages in place from the next model call on. The expansion is stored in the session and lasts until the next compaction.
- `refold` undoes an expansion.

## Compaction text stored in the session

The compaction entry's `summary` holds the same placeholders as plain text, so a session opened without this extension still shows the folded briefs. Fold state lives in the entry's `details`.

## Install

```sh
pi install git:github.com/YanzuoLu/pi-fold-compact
```

Use it as the only compaction backend. Another extension that also answers `session_before_compact` would compete for the same compaction.

## Development

```sh
npm install
npm run check
```

## License

MIT. Includes pi-fold 4.2.8 by Shane Conner under the MIT License.
