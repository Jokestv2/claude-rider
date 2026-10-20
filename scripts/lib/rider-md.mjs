// scripts/lib/rider-md.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { parseFrontmatter } from "./yaml-subset.mjs";

export const RESERVED = ["operator", "resume"];
export const DEFAULT_VISITS = 3;
/** An await phase's numeric keys (§7.1), with their defaults: no `timeoutHours` is no deadline. */
const AWAIT_DEFAULTS = { pollSeconds: 300, checkTimeoutSeconds: 300, timeoutHours: null };
/** An instance id names a directory under `.rider/<rider>/` and is a token on the event line (§5.1). */
export const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
/** Ids that would collide with the files the instances' directories sit beside in `.rider/<rider>/`. */
export const RESERVED_IDS = ["local.json", "run.json"];

/** `riders/<name>/RIDER.md` under the project root — the discovery rule of skills. */
export function discoverRiders(root) {
  const dir = join(root, "riders");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "RIDER.md")))
    .sort()
    .map((d) => ({ name: d, dir: join(dir, d), file: join(dir, d, "RIDER.md") }));
}

export function loadRider(file) {
  const dir = dirname(file);
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
  const errors = validateRider(data, (p) => existsSync(join(dir, p)));
  // The CLI finds a rider by its directory and the watcher is respawned by its name: two names would split one rider (§5.2).
  if (typeof data?.name === "string" && data.name !== basename(dir)) errors.push(`name "${data.name}" must equal its directory name "${basename(dir)}"`);
  if (errors.length) throw new Error(`${file} is not a valid rider:\n  ${errors.join("\n  ")}`);
  return normalize(data, dir, body);
}

/** Graph validity (§2.2). Returns [] when valid; `promptExists(relPath)` is injected. */
export function validateRider(data, promptExists) {
  const e = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["frontmatter is not a mapping"];
  if (typeof data.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(data.name)) e.push("name: required; letters, digits and dashes");
  if (data.instances != null) e.push(...instancesErrors(data.instances));
  const phases = data.phases;
  if (!phases || typeof phases !== "object" || Array.isArray(phases)) return [...e, "phases: required mapping of phase name → phase"];
  const names = Object.keys(phases);
  for (const r of RESERVED) if (names.includes(r)) e.push(`phases.${r}: reserved name`);
  // A phase name becomes a path segment (the harvest log's file name) and a token on the event line.
  for (const n of names) if (!/^[A-Za-z0-9_-]+$/.test(n)) e.push(`phases.${n}: name must be letters, digits, underscores and dashes`);
  // `start:` is the canonical entry, so it names a session phase; `locate` and the operator may still name a gate or a
  // wait (§6.2, §7.5).
  if (typeof data.start !== "string") e.push("start: required");
  else if (!names.includes(data.start)) e.push(`start: "${data.start}" is not a declared phase`);
  else if (phases[data.start]?.human === true) e.push(`start: "${data.start}" is a human phase`);
  else if (phases[data.start]?.await === true) e.push(`start: "${data.start}" is an await phase`);
  if (data.locate != null && (typeof data.locate !== "string" || !data.locate.trim())) e.push("locate: must be one non-empty shell command");
  for (const [name, p] of Object.entries(phases)) {
    if (!p || typeof p !== "object" || Array.isArray(p)) { e.push(`phases.${name}: not a mapping`); continue; }
    if (p.human === true) {
      if (typeof p.check !== "string" || !p.check.trim()) e.push(`phases.${name}: a human phase needs a check command`);
      // Entering a human phase spends nothing, so it has nothing for `requires` to guard (§5.1).
      for (const k of ["prompt", "model", "edges", "requires"]) if (k in p) e.push(`phases.${name}: ${k} is not allowed on a human phase`);
      if (p.await === true) e.push(`phases.${name}: a phase is human or await, not both`);
      continue;
    }
    if (p.await === true) {
      if (typeof p.check !== "string" || !p.check.trim()) e.push(`phases.${name}: an await phase needs a check command`);
      // No session is launched there (§7.1): nothing would read a prompt or run a model.
      for (const k of ["prompt", "model"]) if (k in p) e.push(`phases.${name}: ${k} is not allowed on an await phase`);
      if (p.show != null && typeof p.show !== "string") e.push(`phases.${name}: show must be one shell command`);
      // Each carries its unit in its name, so the subset reader needs no duration parser (§7.1).
      for (const k of Object.keys(AWAIT_DEFAULTS)) if (p[k] != null && !(Number.isFinite(p[k]) && p[k] > 0)) e.push(`phases.${name}: ${k} must be a positive number`);
    } else {
      const prompt = typeof p.prompt === "string" ? p.prompt : `${name}.md`;
      if (!promptExists(prompt)) e.push(`phases.${name}: prompt file ${prompt} not found`);
      if (typeof p.model !== "string" || !p.model.trim()) e.push(`phases.${name}: model is required`);
    }
    // A session phase and a wait share these: both are left by a judged label, and both may be guarded (§5.1, §7.1).
    if (p.requires != null && (!Array.isArray(p.requires) || p.requires.some((c) => typeof c !== "string" || !c.trim()))) e.push(`phases.${name}: requires must be a list of shell commands`);
    if (!p.edges || typeof p.edges !== "object" || Array.isArray(p.edges) || !Object.keys(p.edges).length) e.push(`phases.${name}: edges is required (outcome label → phase)`);
    else for (const [label, to] of Object.entries(p.edges)) {
      if (RESERVED.includes(label)) e.push(`phases.${name}.edges: "${label}" is a reserved label`);
      if (to !== "operator" && !names.includes(to)) e.push(`phases.${name}.edges.${label}: "${to}" is not a declared phase`);
    }
  }
  for (const k of ["intake", "evidence"]) {
    if (data[k] != null && (!Array.isArray(data[k]) || data[k].some((c) => typeof c !== "string"))) e.push(`${k}: must be a list of shell commands`);
  }
  if (data.limits != null) {
    if (typeof data.limits !== "object") e.push("limits: must be a mapping");
    else if (data.limits.visits != null && !(Number.isInteger(data.limits.visits) && data.limits.visits >= 1)) e.push("limits.visits: must be a positive integer");
  }
  return e;
}

/** One directory glob under the root with `*` as its only wildcard, and only in the last segment, so that listing
 *  the instances is one readdir of a directory inside the project (§5.1). */
function instancesErrors(glob) {
  if (typeof glob !== "string") return ["instances: must be one directory glob, such as nodes/*"];
  const e = [];
  const segs = glob.split("/");
  if (glob.startsWith("/") || glob.includes("\\") || segs.includes("..")) e.push("instances: must be relative to the project root: no leading /, no \\, no .. segment");
  if (segs.slice(0, -1).some((s) => s.includes("*"))) e.push("instances: only the last segment may contain *");
  if (/[?[\]{}]/.test(glob)) e.push("instances: * is the only wildcard; ? [ ] { } are not allowed");
  return e;
}

function normalize(data, dir, body) {
  const phases = {};
  for (const [name, p] of Object.entries(data.phases)) {
    const show = typeof p.show === "string" ? p.show : null;
    if (p.human === true) phases[name] = { kind: "human", check: p.check, show };
    // Every default is filled here: the watcher multiplies these, and an undefined one would reach a timer as NaN.
    else if (p.await === true) {
      const d = AWAIT_DEFAULTS;
      phases[name] = { kind: "await", check: p.check, show, pollSeconds: p.pollSeconds ?? d.pollSeconds, checkTimeoutSeconds: p.checkTimeoutSeconds ?? d.checkTimeoutSeconds, timeoutHours: p.timeoutHours ?? d.timeoutHours, requires: [...(p.requires ?? [])], edges: { ...p.edges } };
    } else phases[name] = { kind: "session", prompt: join(dir, typeof p.prompt === "string" ? p.prompt : `${name}.md`), model: p.model, edges: { ...p.edges }, requires: [...(p.requires ?? [])] };
  }
  return {
    name: data.name, dir, start: data.start, locate: data.locate ?? null, phases, instances: data.instances ?? null,
    intake: data.intake ?? [], evidence: data.evidence ?? [],
    limits: { visits: data.limits?.visits ?? DEFAULT_VISITS },
    body,
  };
}

/** The only labels the judge may pick at `phase`: its edges, then the reserved ones its kind admits. A wait has no
 *  session to resume (§7.5), and a gate is left by its check, never by a label. */
export function legalLabels(rider, phase) {
  const p = rider.phases[phase];
  if (p?.kind !== "session" && p?.kind !== "await") return [];
  return [
    ...Object.entries(p.edges).map(([label, to]) => ({ label, to })),
    ...(p.kind === "session" ? [{ label: "resume", to: phase }] : []),
    { label: "operator", to: "operator" },
  ];
}

/** The edges `overrule` may take: the ones that leave for another phase. `operator` again is no ruling,
 *  and `resume` re-enters a session with a nudge that says the environment cut it short — untrue of a
 *  judged stop. */
export const onwardEdges = (rider, phase) => legalLabels(rider, phase).filter((l) => l.to !== "operator" && l.label !== "resume");
/** The labels `overrule` would accept for an ended run; empty when there is no judge's call to overrule. */
export function overrulable(rider, run) {
  const stop = run?.transitions?.at(-1);
  if (run?.endedBy !== "operator" || stop?.to !== "operator" || stop.by === "executor") return [];
  return onwardEdges(rider, run.phase).map((l) => l.label);
}

/** Follows symlinks, as a shell glob does; a dangling link or an unreadable entry is no directory. */
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** The instances are the directories that exist now: creating one creates an instance, and nothing is registered
 *  (§5.1). Without `instances` a rider has one, `default`, scoped to the root. */
export function listInstances(root, rider) {
  if (rider.instances == null) return { declared: false, instances: [{ id: "default", scope: "." }], skipped: [] };
  const segs = rider.instances.split("/");
  const last = segs.pop();
  const parent = posix.normalize(segs.join("/"));
  const prefix = parent === "." ? "" : `${parent}/`;
  const pattern = last.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  const match = new RegExp(`^${pattern}$`);
  const dir = join(root, parent);
  const instances = [], skipped = [];
  if (!isDir(dir)) return { declared: true, instances, skipped };
  // Sorting the names sorts both lists: every scope shares one prefix. A dot-name is never matched, as in a shell glob.
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || !match.test(name) || !isDir(join(dir, name))) continue;
    const scope = `${prefix}${name}`;
    if (!SAFE_ID.test(name)) skipped.push({ path: scope, reason: "not a safe id (letters, digits, _, . and -; not starting with .)" });
    else if (RESERVED_IDS.includes(name)) skipped.push({ path: scope, reason: "reserved name" });
    else instances.push({ id: name, scope });
  }
  return { declared: true, instances, skipped };
}
