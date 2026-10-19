// test/fake-binding.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { classifyNoMarker, parseResetTime } from "../scripts/bindings/claude-code.mjs";

const EMPTY_READ = { lastText: null, lastAt: null, question: null, turns: 0, userTurns: 0, userTurnDetails: [], cost: null, costEntries: 0, signal: "", transcript: null, tail: [] };

export class FakeBinding {
  name = "fake";
  heuristics = { classifyNoMarker, parseResetTime };
  dryRun = {
    launchArgv: (prompt, o) => ["fake", "--model", o.model, "-n", o.name, prompt.slice(0, 20), ...(o.facts ?? [])],
    resumeArgv: (id, o) => ["fake", "--resume", id, o.listed ? "bare" : "with-options", ...(o.facts ?? [])],
  };
  constructor({ script = [], stateFile = null } = {}) {
    this.stateFile = stateFile;
    this.s = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { scripts: [...script], sessions: {}, n: 0, calls: [] };
  }
  get calls() { this.#load(); return this.s.calls; }
  /** With a state file, re-read before every call: another process (the CLI e2e drives one verb per process) may have written. */
  #load() { if (this.stateFile) this.s = JSON.parse(readFileSync(this.stateFile, "utf8")); }
  #save() { if (this.stateFile) writeFileSync(this.stateFile, JSON.stringify(this.s)); }
  #take() { const sc = this.s.scripts.shift(); if (!sc) throw new Error("fake binding: script exhausted"); return sc; }
  #find(ids) {
    const all = Object.values(this.s.sessions);
    return all.find((x) => ids.shortId && x.shortId === ids.shortId) ?? all.find((x) => ids.sessionId && x.sessionId === ids.sessionId && x.current) ?? null;
  }
  #open(sc, sessionId, name) {
    const n = ++this.s.n;
    const id = sc.sessionId ?? sessionId ?? `sess-${n}`;
    for (const x of Object.values(this.s.sessions)) if (x.sessionId === id) x.current = false;
    const sess = { shortId: `s${n}`, sessionId: id, name, current: true, pid: 1000 + n, statuses: [...(sc.statuses ?? ["done"])], read: { ...EMPTY_READ, turns: 3, userTurns: 1, cost: 1.5, ...(sc.read ?? {}) } };
    this.s.sessions[sess.shortId] = sess;
    this.#save();
    return { shortId: sess.shortId, sessionId: id, name };
  }
  // `facts` is recorded as passed, with no default: a verb that forgets to pass them then shows `undefined`, not `[]`.
  launch(prompt, o) { this.#load(); this.s.calls.push({ call: "launch", prompt, model: o.model, name: o.name, cwd: o.cwd, facts: o.facts }); return this.#open(this.#take(), null, o.name); }
  resume(sessionId, o) { this.#load(); this.s.calls.push({ call: "resume", sessionId, listed: o.listed, model: o.model, name: o.name, facts: o.facts }); return this.#open(this.#take(), sessionId, o.name); }
  status(ids) {
    this.#load();
    const x = this.#find(ids);
    if (!x) return { kind: "gone", entry: null, listed: false };
    const next = x.statuses.length > 1 ? x.statuses.shift() : x.statuses[0];
    this.#save();
    // A scripted status is a kind string or { kind, listed, entry }: the registry can still list a session whose
    // process died, and `entry` adds the raw registry fields (`status`, `state`) a sample was taken with.
    const { kind, listed = kind !== "gone", entry = {} } = typeof next === "string" ? { kind: next } : next;
    return { kind, entry: listed ? { id: x.shortId, sessionId: x.sessionId, pid: kind === "gone" ? null : x.pid, name: x.name, ...entry } : null, listed };
  }
  read(ids) { this.#load(); const x = this.#find(ids); return x ? { ...x.read, transcript: `/fake/${x.sessionId}.jsonl` } : { ...EMPTY_READ }; }
  stop(ids) { this.#load(); this.s.calls.push({ call: "stop", shortId: ids.shortId }); const x = this.#find(ids); if (x) { x.read.costEntries += 1; x.pid = null; x.statuses = ["done"]; } this.#save(); }
  attachHint(ids) { return `claude attach ${ids.shortId ?? ids.sessionId}`; }
  stopHint(ids) { return `claude stop ${ids.shortId ?? ids.sessionId}`; }
}

/** Module form for the CLI: `RIDER_BINDING=<this file> RIDER_FAKE_STATE=<json>`; seed the json with {"scripts":[…]}. */
export function createBinding() {
  const file = process.env.RIDER_FAKE_STATE;
  if (!file) throw new Error("fake binding: set RIDER_FAKE_STATE to a state file seeded with {\"scripts\":[…]}");
  const seeded = JSON.parse(readFileSync(file, "utf8"));
  if (!seeded.sessions) writeFileSync(file, JSON.stringify({ scripts: seeded.scripts ?? [], sessions: {}, n: 0, calls: [] }));
  return new FakeBinding({ stateFile: file });
}
