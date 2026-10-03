// The firstmate adapter: everything that knows firstmate's on-disk layout lives here.
//
// Every reader is read-only, needs no network, and answers "nothing" for a directory that
// is not a firstmate home, so the advisers built on it are inert everywhere else. The only
// write is `dropBackpassNote`, which goes through firstmate's own `bin/fm-inbox.sh`.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface FirstmateHome {
  root: string;
  /** False in a secondmate home, which stows but neither updates firstmate nor runs backpass. */
  primary: boolean;
}

/** Files only a firstmate home has; all must be present, plus a `state/` directory. */
const MARKERS = [
  "bin/fm-inbox.sh",
  "bin/fm-update.sh",
  ".agents/skills/stow/SKILL.md",
  ".agents/skills/updatefirstmate/SKILL.md",
];

/**
 * The firstmate home whose root is exactly `cwd`, else undefined. A worker's worktree, a
 * subdirectory such as `projects/<repo>`, or `$FM_HOME` in the environment never count:
 * only the session running in the home itself holds firstmate's memory.
 */
export function firstmateHome(cwd: string): FirstmateHome | undefined {
  try {
    const root = realpathSync(cwd);
    if (!statSync(join(root, "state")).isDirectory()) return undefined;
    for (const marker of MARKERS) if (!statSync(join(root, marker)).isFile()) return undefined;
    return { root, primary: !existsSync(join(root, ".fm-secondmate-home")) };
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The watcher rewrites `state/.tool-updates` about every 15 minutes; older is stale. */
export const TOOL_UPDATES_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * The `firstmate update available: ...` finding from firstmate's own tool-update check
 * (`bin/fm-tool-update-check.sh`), or undefined when there is none or the cache is stale,
 * malformed, or missing. This never fetches: the check already did its read-only probe.
 */
export function firstmateUpdate(home: FirstmateHome, nowMs: number): string | undefined {
  const text = readText(join(home.root, "state", ".tool-updates"));
  if (!text) return undefined;
  const [schema, ...lines] = text.split("\n");
  if (schema?.trim() !== "fm-tool-updates-v1") return undefined;
  const fields = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const epoch = Number(fields.get("epoch"));
  if (!Number.isSafeInteger(epoch) || epoch <= 0) return undefined;
  const age = nowMs - epoch * 1000;
  if (age > TOOL_UPDATES_MAX_AGE_MS || age < -5 * 60 * 1000) return undefined;
  return (fields.get("reported") ?? "")
    .split("; ")
    .map((finding) => finding.trim())
    .find((finding) => finding.startsWith("firstmate update available:"));
}

export interface LaneEvent {
  state: string;
  at: number | undefined;
  text: string;
}

const EVENT =
  /^(working|paused|blocked|needs-decision|done|failed|resolved)((?: \[[a-z]+=[^\]]*\])*):\s?(.*)$/;

/** The events of a lane's append-only `state/<id>.status` log; continuation prose is skipped. */
export function laneEvents(text: string): LaneEvent[] {
  const events: LaneEvent[] = [];
  for (const line of text.split("\n")) {
    const match = EVENT.exec(line.trim());
    if (!match) continue;
    const at = /\[at=(\d+)\]/.exec(match[2] ?? "")?.[1];
    events.push({
      state: match[1] as string,
      at: at ? Number(at) : undefined,
      text: match[3] ?? "",
    });
  }
  return events;
}

interface Lane {
  id: string;
  meta: Map<string, string>;
  events: LaneEvent[];
}

/** Live lanes: a `state/<id>.meta` exists from spawn until teardown. */
function liveLanes(stateDir: string): Lane[] {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".meta") && !name.startsWith("."))
    .map((name) => {
      const id = name.slice(0, -".meta".length);
      const meta = new Map<string, string>();
      for (const line of (readText(join(stateDir, name)) ?? "").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) meta.set(line.slice(0, eq), line.slice(eq + 1).trim());
      }
      return { id, meta, events: laneEvents(readText(join(stateDir, `${id}.status`)) ?? "") };
    });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Secondmate homes registered in `data/secondmates.md` as `(home: <absolute path>; ...)`. */
function secondmateHomes(home: FirstmateHome): string[] {
  const text = readText(join(home.root, "data", "secondmates.md")) ?? "";
  return [...text.matchAll(/\(home: (\/[^;)]+)[;)]/g)].map((m) => (m[1] as string).trim());
}

const HARDWARE = /\b(?:hardware|downtime|maintenance window|node(?:-2)?\.local)\b/i;
const RELEASE = /\b(?:releas(?:e|es|ing)|publish(?:es|ing)?)\b/i;
const VALIDATION = /\b(?:validat\w*|verif\w*|pipeline|no-mistakes|ci|checks?|tests?|testing)\b/i;

/**
 * Why the fleet is not idle enough to update firstmate, or undefined when it is. Firstmate
 * records none of these as a flag, so each is read from what it does leave behind, erring
 * toward "busy" (silence) rather than toward an update in the middle of something:
 * - a merge holds `state/.control-<id>.lock` (a live pid) while `bin/fm-pr-merge.sh` runs;
 * - a hardware window, release, or validation is a live lane whose latest event is
 *   `working`/`paused` and names it (validation counts only when the lane `paused` for it).
 * The primary home and every registered secondmate home are checked.
 */
export function fleetBusy(
  home: FirstmateHome,
  alive: (pid: number) => boolean = pidAlive,
): string | undefined {
  for (const root of [home.root, ...secondmateHomes(home)]) {
    const stateDir = join(root, "state");
    let names: string[] = [];
    try {
      names = readdirSync(stateDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const lock = /^\.control-(.+)\.lock$/.exec(name);
      if (!lock) continue;
      const pid = Number(readText(join(stateDir, name, "pid"))?.trim());
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid))
        return `a merge is in flight (${lock[1]})`;
    }
    for (const lane of liveLanes(stateDir)) {
      const latest = lane.events.filter((e) => e.state !== "resolved").at(-1);
      if (!latest || (latest.state !== "working" && latest.state !== "paused")) continue;
      if (/^hw-/i.test(lane.id) || HARDWARE.test(latest.text))
        return `a hardware window is open (${lane.id})`;
      if (RELEASE.test(latest.text)) return `a release is in flight (${lane.id})`;
      if (latest.state === "paused" && VALIDATION.test(latest.text))
        return `a worker is mid-validation (${lane.id})`;
    }
  }
  return undefined;
}

export interface Repo {
  name: string;
  /** Real path of the repository's checkout. */
  path: string;
}

/** Registered projects: each entry of `<home>/projects/` (a clone or a symlink to one). */
export function registeredRepos(home: FirstmateHome): Repo[] {
  let names: string[];
  try {
    names = readdirSync(join(home.root, "projects"));
  } catch {
    return [];
  }
  const repos = new Map<string, Repo>();
  for (const name of names.sort()) {
    try {
      const path = realpathSync(join(home.root, "projects", name));
      if (statSync(path).isDirectory() && existsSync(join(path, ".git")) && !repos.has(path))
        repos.set(path, { name, path });
    } catch {
      // A dangling project link is not a repository.
    }
  }
  return [...repos.values()];
}

/**
 * Open backpass rounds, by repository path: a live `bp-*` lane, keyed by its meta's
 * `project=`, started at its first status event (or the meta's mtime).
 */
export function openBackpassRounds(home: FirstmateHome): Map<string, number> {
  const rounds = new Map<string, number>();
  const stateDir = join(home.root, "state");
  for (const lane of liveLanes(stateDir)) {
    if (!lane.id.startsWith("bp-")) continue;
    const project = lane.meta.get("project");
    if (!project) continue;
    let path: string;
    try {
      path = realpathSync(project);
    } catch {
      continue;
    }
    const first = lane.events.find((e) => e.at !== undefined)?.at;
    let started = first !== undefined ? first * 1000 : Number.NaN;
    if (!Number.isFinite(started)) {
      try {
        started = statSync(join(stateDir, `${lane.id}.meta`)).mtimeMs;
      } catch {
        continue;
      }
    }
    rounds.set(path, Math.min(rounds.get(path) ?? started, started));
  }
  return rounds;
}

/** Session start from a Pi/omp session file name (`2026-10-03T03-16-23-706Z_<id>.jsonl`). */
function sessionStart(dir: string, file: string): number {
  const stamp = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(file);
  if (stamp) return Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`);
  try {
    return statSync(join(dir, file)).birthtimeMs;
  } catch {
    return Number.NaN;
  }
}

/** The `cwd` in a session file's header (`{"type":"session",...,"cwd":...}`). */
function sessionCwd(path: string): string | undefined {
  const head = (readText(path) ?? "").slice(0, 16384);
  for (const line of head.split("\n").slice(0, 4)) {
    try {
      const entry = JSON.parse(line) as { type?: unknown; cwd?: unknown };
      if (entry.type === "session" && typeof entry.cwd === "string") return entry.cwd;
    } catch {
      // Not a JSON header line.
    }
  }
  return undefined;
}

/**
 * The repository a session ran in: inside its checkout (the deepest match), in a git
 * worktree whose `.git` points into it, or, for a removed worktree, under Orca's
 * `orca/workspaces/<repo directory name>/` layout when that name is unambiguous.
 */
export function repoForCwd(cwd: string, repos: readonly Repo[]): Repo | undefined {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // The worktree may be gone; match the recorded path.
  }
  const inside = repos
    .filter((r) => real === r.path || real.startsWith(r.path + sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (inside) return inside;
  const pointer = /^gitdir:\s*(.+)$/m.exec(readText(join(real, ".git")) ?? "")?.[1]?.trim();
  if (pointer) {
    const owner = repos.find((r) => pointer.startsWith(join(r.path, ".git") + sep));
    if (owner) return owner;
  }
  const orca = /\/orca\/workspaces\/([^/]+)\//.exec(`${real}/`)?.[1];
  if (orca) {
    const named = repos.filter((r) => basename(r.path) === orca);
    if (named.length === 1) return named[0];
  }
  return undefined;
}

/**
 * Agent sessions per repository started at or after that repository's `since` (ms). Reads
 * the agent's `sessions/<encoded cwd>/` directories; `cwds` caches each directory's cwd.
 */
export function sessionCounts(
  sessionsDir: string,
  repos: readonly Repo[],
  since: ReadonlyMap<string, number>,
  cwds: Map<string, string | undefined> = new Map(),
): Map<string, number> {
  const counts = new Map<string, number>(repos.map((r) => [r.path, 0]));
  if (!repos.length) return counts;
  const earliest = Math.min(...repos.map((r) => since.get(r.path) ?? 0));
  let dirs: string[];
  try {
    dirs = readdirSync(sessionsDir);
  } catch {
    return counts;
  }
  for (const name of dirs) {
    const dir = join(sessionsDir, name);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const starts = files.map((f) => sessionStart(dir, f));
    if (!starts.some((start) => start >= earliest)) continue;
    if (!cwds.has(dir)) {
      const newest = files[starts.indexOf(Math.max(...starts.filter(Number.isFinite)))];
      cwds.set(dir, newest ? sessionCwd(join(dir, newest)) : undefined);
    }
    const cwd = cwds.get(dir);
    const repo = cwd ? repoForCwd(cwd, repos) : undefined;
    if (!repo) continue;
    const from = since.get(repo.path) ?? 0;
    counts.set(repo.path, (counts.get(repo.path) ?? 0) + starts.filter((s) => s >= from).length);
  }
  return counts;
}

/** Commits on `origin/main` (else `HEAD`) since `sinceMs`, from the local refs only. */
export async function commitCount(repo: string, sinceMs: number): Promise<number | undefined> {
  const since = `--since=${new Date(sinceMs).toISOString()}`;
  for (const ref of ["origin/main", "HEAD"]) {
    try {
      const { stdout } = await run("git", ["-C", repo, "rev-list", "--count", since, ref], {
        timeout: 5000,
      });
      const count = Number(stdout.trim());
      if (Number.isSafeInteger(count)) return count;
    } catch {
      // Try the next ref.
    }
  }
  return undefined;
}

/** ISO-8601 week number and week-year of a local date, as `date +%V` / `%G` print them. */
export function isoWeek(date: Date): { year: number; week: number } {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  day.setDate(day.getDate() + 3 - ((day.getDay() + 6) % 7));
  const firstThursday = new Date(day.getFullYear(), 0, 4);
  const week =
    1 +
    Math.round(
      ((day.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getDay() + 6) % 7)) /
        7,
    );
  return { year: day.getFullYear(), week };
}

/**
 * Drop the same firstmate inbox note the weekly backpass job drops, naming the repositories
 * that are due, through `bin/fm-inbox.sh note --request-id` so a repeat is a replay.
 */
export async function dropBackpassNote(
  home: FirstmateHome,
  names: readonly string[],
  now: Date,
): Promise<void> {
  const { year, week } = isoWeek(now);
  const tag = `w${String(week).padStart(2, "0")}`;
  const text = `Backpass round is due for ${names.join(", ")}: the backpass adviser counted enough new agent sessions or commits since their last round. Run python3 data/backpass-weekly/dispatch.py ${tag} from the firstmate home for these repos, then supervise the per-repo review boards.`;
  const requestId = `backpass-adviser-${year}-${tag}-${names.join(".")}`
    .replace(/[^A-Za-z0-9._:-]/g, "-")
    .slice(0, 128);
  await run(
    join(home.root, "bin", "fm-inbox.sh"),
    ["note", "--request-id", requestId, "--", text],
    {
      cwd: home.root,
      env: { ...process.env, FM_HOME: home.root },
      timeout: 10000,
    },
  );
}
