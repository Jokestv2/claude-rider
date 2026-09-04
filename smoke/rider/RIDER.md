---
name: smoke
start: one
phases:
  one:
    model: haiku
    edges: { done: two }
  two:
    model: haiku
    edges: { done: three }
  three:
    model: haiku
    edges: { done: finish }
  finish:
    human: true
    check: test -f merged.flag
---
Smoke rider: three one-turn haiku phases. Never carries a real prompt.
