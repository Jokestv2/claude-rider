---
name: pair
instances: work/*
start: one
phases:
  one:
    model: haiku
    edges: { done: operator }
---
Smoke rider for instances: one one-turn haiku phase, run once per directory under work/. The smoke copies it to
riders/pair, and a rider's name must equal its directory, so it is named pair. Never carries a real prompt.
