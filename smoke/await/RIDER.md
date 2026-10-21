---
name: await
start: one
phases:
  one:
    model: haiku
    edges: { done: wait }
  wait:
    await: true
    check: test -f ready.flag || exit 75
    pollSeconds: 2
    edges: { settled: operator }
---
Smoke rider for await phases: the smoke starts the run at wait, so no session is launched. The smoke copies it to
riders/await, and a rider's name must equal its directory, so it is named await. Never carries a real prompt.
