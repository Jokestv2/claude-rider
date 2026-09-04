// test/fake-binding.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { classifyNoMarker, parseResetTime } from "../scripts/bindings/claude-code.mjs";

const EMPTY_READ = { lastText: null, question: null, turns: 0, userTurns: 0, cost: null, costEntries: 0, signal: "", transcript: null, tail: [] };

export class FakeBinding {
  name = "fake";
  heuristics = { classifyNoMarker, parseResetTime };
  dryRun = {
    launchArgv: (prompt, o) => ["fake", "--model", o.model, "-n", o.name, prompt.slice(0, 20)],
    resumeArgv: (id, o) => ["fake", "--resume", id, o.listed ? "bare" : "with-options"],
  };
  constructor({ script = [], stateFile = null } = {}) {
    this.stateFile = stateFile;
    this.s = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { scripts: [...script], sessions: {}, n: 0, calls: [] };
  }
  get calls() { return this.s.calls; }
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
  launch(prompt, o) { this.s.calls.push({ call: "launch", prompt, model: o.model, name: o.name, cwd: o.cwd }); return this.#open(this.#take(), null, o.name); }
  resume(sessionId, o) { this.s.calls.push({ call: "resume", sessionId, listed: o.listed, model: o.model, name: o.name }); return this.#open(this.#take(), sessionId, o.name); }
  status(ids) {
    const x = this.#find(ids);
    if (!x) return { kind: "gone", entry: null, listed: false };
    const kind = x.statuses.length > 1 ? x.statuses.shift() : x.statuses[0];
    this.#save();
    if (kind === "gone") return { kind, entry: null, listed: false };
    return { kind, entry: { id: x.shortId, sessionId: x.sessionId, pid: x.pid, name: x.name }, listed: true };
  }
  read(ids) { const x = this.#find(ids); return x ? { ...x.read, transcript: `/fake/${x.sessionId}.jsonl` } : { ...EMPTY_READ }; }
  stop(ids) { this.s.calls.push({ call: "stop", shortId: ids.shortId }); const x = this.#find(ids); if (x) { x.read.costEntries += 1; x.pid = null; x.statuses = ["done"]; } this.#save(); }
  attachHint(ids) { return `claude attach ${ids.shortId ?? ids.sessionId}`; }
}

/** Module form for the CLI: `RIDER_BINDING=<this file> RIDER_FAKE_STATE=<json>`; seed the json with {"scripts":[…]}. */
export function createBinding() {
  const file = process.env.RIDER_FAKE_STATE;
  if (!file) throw new Error("fake binding: set RIDER_FAKE_STATE to a state file seeded with {\"scripts\":[…]}");
  const seeded = JSON.parse(readFileSync(file, "utf8"));
  if (!seeded.sessions) writeFileSync(file, JSON.stringify({ scripts: seeded.scripts ?? [], sessions: {}, n: 0, calls: [] }));
  return new FakeBinding({ stateFile: file });
}
