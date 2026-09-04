// scripts/lib/rider-md.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "./yaml-subset.mjs";

export const RESERVED = ["operator", "resume"];
export const DEFAULT_VISITS = 3;

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
  if (errors.length) throw new Error(`${file} is not a valid rider:\n  ${errors.join("\n  ")}`);
  return normalize(data, dir, body);
}

/** Graph validity (§2.2). Returns [] when valid; `promptExists(relPath)` is injected. */
export function validateRider(data, promptExists) {
  const e = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["frontmatter is not a mapping"];
  if (typeof data.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(data.name)) e.push("name: required; letters, digits and dashes");
  const phases = data.phases;
  if (!phases || typeof phases !== "object" || Array.isArray(phases)) return [...e, "phases: required mapping of phase name → phase"];
  const names = Object.keys(phases);
  for (const r of RESERVED) if (names.includes(r)) e.push(`phases.${r}: reserved name`);
  if (typeof data.start !== "string") e.push("start: required");
  else if (!names.includes(data.start)) e.push(`start: "${data.start}" is not a declared phase`);
  else if (phases[data.start]?.human === true) e.push(`start: "${data.start}" is a human phase`);
  for (const [name, p] of Object.entries(phases)) {
    if (!p || typeof p !== "object" || Array.isArray(p)) { e.push(`phases.${name}: not a mapping`); continue; }
    if (p.human === true) {
      if (typeof p.check !== "string" || !p.check.trim()) e.push(`phases.${name}: a human phase needs a check command`);
      for (const k of ["prompt", "model", "edges"]) if (k in p) e.push(`phases.${name}: ${k} is not allowed on a human phase`);
      continue;
    }
    const prompt = typeof p.prompt === "string" ? p.prompt : `${name}.md`;
    if (!promptExists(prompt)) e.push(`phases.${name}: prompt file ${prompt} not found`);
    if (typeof p.model !== "string" || !p.model.trim()) e.push(`phases.${name}: model is required`);
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

function normalize(data, dir, body) {
  const phases = {};
  for (const [name, p] of Object.entries(data.phases)) {
    phases[name] = p.human === true
      ? { kind: "human", check: p.check, show: typeof p.show === "string" ? p.show : null }
      : { kind: "session", prompt: join(dir, typeof p.prompt === "string" ? p.prompt : `${name}.md`), model: p.model, edges: { ...p.edges } };
  }
  return {
    name: data.name, dir, start: data.start, phases,
    intake: data.intake ?? [], evidence: data.evidence ?? [],
    limits: { visits: data.limits?.visits ?? DEFAULT_VISITS },
    body,
  };
}

/** The only labels the judge may pick at `phase`: its edges, then the two reserved ones. */
export function legalLabels(rider, phase) {
  const p = rider.phases[phase];
  if (!p || p.kind !== "session") return [];
  return [
    ...Object.entries(p.edges).map(([label, to]) => ({ label, to })),
    { label: "resume", to: phase },
    { label: "operator", to: "operator" },
  ];
}
