// scripts/lib/shell.mjs
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Intake, evidence and human-phase check commands are POSIX shell lines. On Windows the
 * platform shell is cmd.exe, which cannot run them, so Git Bash is resolved explicitly;
 * `local.json`'s `shell` overrides. (`bash.exe` on PATH may be WSL's — a different filesystem.) */
export function resolveShell(local = {}) {
  if (local.shell) return local.shell;
  if (process.platform !== "win32") return "/bin/sh";
  for (const p of ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"]) if (existsSync(p)) return p;
  return "bash.exe";
}

export function sh(cmd, { cwd = process.cwd(), shell = resolveShell(), timeoutMs = 30_000, capBytes = 2048 } = {}) {
  const r = spawnSync(shell, ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const output = capText(`${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), capBytes);
  return { status: r.error ? -1 : r.status, output, error: r.error?.message ?? null };
}

export function capText(text, bytes) {
  const s = String(text ?? "");
  if (Buffer.byteLength(s) <= bytes) return s;
  const cut = Buffer.from(s).subarray(0, bytes).toString("utf8").replace(/\uFFFD+$/, "");
  return `${cut}\n… capped at ${bytes} bytes`;
}
