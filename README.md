# site-generator-speed-01-run-20261122

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Saripudin7/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Saripudin7/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0: `solve.js` exports
`run(input)` returning exactly makefun-site's output tree for every
`{site, templates, files}` input — every page's `index.html`, the index and
tag pages, `build-report.txt` and each static file, byte for byte. Its front
matter, template dialect, Markdown subset, slug rule and report are
makefun-site's own, reproduced exactly (the code is the reference wherever
the README and the code differ).

The speed comes from doing the same work with less of it: a fused
single-pass Markdown lexer/renderer (no token objects, line kinds dispatched
on the first character instead of a regex battery), inline rendering that
finds the next special or HTML-escapable character with one regex scan and
pushes plain runs unescaped, range-based recursion with no substring copies,
an ASCII fast path for slugification with a per-case cache, front matter
scanned without splitting the whole body, word counts without allocating
matches, post cards computed once and reused, and templates compiled once
to plain functions — with include renders memoized per depth for templates
that only read the per-case constants (`site`, `tags`, `recent`). No
dependencies, no WebAssembly, no native code.

## Run

Node 22 runs the harness entrypoint:

```
node main.ts
```

It reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`), answers
each case with `run`, and writes `/output/answers.json` (or
`$MAKEFUN_OUTPUT_DIR/answers.json`).
