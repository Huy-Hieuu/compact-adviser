// Settings, per-session state and the pure gates of the firstmate advisers (stow, update,
// backpass). Host wiring is in firstmate-adviser.ts; firstmate's layout is in firstmate-home.ts.

import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { JsonStore, type Mode } from "./config.ts";

export type AdviserKind = "stow" | "update" | "backpass";
export const ADVISER_KINDS: readonly AdviserKind[] = ["stow", "update", "backpass"];

/** Per-adviser kill switches, read like `COMPACT_ADVISER_DISABLE`, which beats all three. */
export const ADVISER_DISABLE_ENV: Record<AdviserKind, string> = {
  stow: "COMPACT_ADVISER_STOW_DISABLE",
  update: "COMPACT_ADVISER_UPDATE_DISABLE",
  backpass: "COMPACT_ADVISER_BACKPASS_DISABLE",
};

/** The slash commands the advisers recommend; firstmate's AGENTS.md maps both to skills. */
export const STOW_COMMAND = "/stow";
export const UPDATE_COMMAND = "/updatefirstmate";

export interface AdviserSettings {
  mode: Mode;
  autoAcknowledged: boolean;
}
export interface FirstmateSettings {
  version: 1;
  stow: AdviserSettings & { minContextTokens: number };
  update: AdviserSettings;
  backpass: AdviserSettings & { minSessions: number; minCommits: number };
}
const DEFAULTS: FirstmateSettings = {
  version: 1,
  stow: { mode: "hint", autoAcknowledged: false, minContextTokens: 20000 },
  update: { mode: "hint", autoAcknowledged: false },
  backpass: { mode: "hint", autoAcknowledged: false, minSessions: 8, minCommits: 20 },
};
export const DEFAULT_FIRSTMATE_SETTINGS: Readonly<FirstmateSettings> = Object.freeze(DEFAULTS);

const INVALID = "Invalid firstmate adviser settings. Restore a valid version-1 configuration.";

function count(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(INVALID);
  return value;
}
function section(value: unknown, defaults: AdviserSettings): Record<string, unknown> {
  if (value === undefined) return { ...defaults };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
  const s = value as Record<string, unknown>;
  if (
    (s.mode !== undefined && !["hint", "auto", "off"].includes(String(s.mode))) ||
    (s.autoAcknowledged !== undefined && typeof s.autoAcknowledged !== "boolean")
  )
    throw new Error(INVALID);
  return { ...defaults, ...s };
}
function validate(value: unknown): FirstmateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
  const c = value as Record<string, unknown>;
  if (c.version !== 1) throw new Error(INVALID);
  const d = DEFAULT_FIRSTMATE_SETTINGS;
  const stow = section(c.stow, d.stow);
  const update = section(c.update, d.update);
  const backpass = section(c.backpass, d.backpass);
  return {
    version: 1,
    stow: {
      mode: stow.mode as Mode,
      autoAcknowledged: stow.autoAcknowledged as boolean,
      minContextTokens: count(stow.minContextTokens, d.stow.minContextTokens),
    },
    update: { mode: update.mode as Mode, autoAcknowledged: update.autoAcknowledged as boolean },
    backpass: {
      mode: backpass.mode as Mode,
      autoAcknowledged: backpass.autoAcknowledged as boolean,
      minSessions: count(backpass.minSessions, d.backpass.minSessions),
      minCommits: count(backpass.minCommits, d.backpass.minCommits),
    },
  };
}

/** `<agentDir>/compact-adviser-firstmate.json`, separate so older versions never strip it. */
export class FirstmateSettingsStore extends JsonStore<FirstmateSettings> {
  constructor(agentDir: string) {
    super(
      join(agentDir, "compact-adviser-firstmate.json"),
      validate,
      DEFAULT_FIRSTMATE_SETTINGS,
      "Cannot read firstmate adviser settings; firstmate advice is disabled.",
    );
  }
}

export interface BackpassRecord {
  version: 1;
  /** Firstmate home root -> repository path -> last backpass round (ms since epoch). */
  homes: Record<string, Record<string, number>>;
}
function validateRecord(value: unknown): BackpassRecord {
  const r = value as { version?: unknown; homes?: unknown } | null;
  if (r?.version !== 1 || !r.homes || typeof r.homes !== "object" || Array.isArray(r.homes))
    throw new Error("Invalid backpass record.");
  for (const repos of Object.values(r.homes as Record<string, unknown>)) {
    if (!repos || typeof repos !== "object" || Array.isArray(repos))
      throw new Error("Invalid backpass record.");
    for (const at of Object.values(repos as Record<string, unknown>))
      if (typeof at !== "number" || !Number.isFinite(at) || at < 0)
        throw new Error("Invalid backpass record.");
  }
  return { version: 1, homes: r.homes as BackpassRecord["homes"] };
}

/** The last backpass round per repository, kept by the adviser (firstmate records none). */
export class BackpassRecordStore extends JsonStore<BackpassRecord> {
  constructor(agentDir: string) {
    super(
      join(agentDir, "compact-adviser-backpass.json"),
      validateRecord,
      { version: 1, homes: {} },
      "Cannot read the backpass round record; backpass advice is disabled.",
    );
  }
}

export const FIRSTMATE_STATE_TYPE = "compact-adviser:firstmate-state";
export interface FirstmateState {
  version: 1;
  lastSettled: string | null;
  completed: number;
  /** Entry id of the latest `/stow` the person or the adviser sent, and what followed. */
  stowMark: string | null;
  stowCompleted: number | null;
  stowBaseline: number | null;
  /** The latest stow judgment qualified and no `/stow` has run since. */
  stowDue: boolean;
  /** A compaction was already held back (or warned about) for the current `stowDue`. */
  stowCompactionHeld: boolean;
  stowHintKey: string | null;
  updateMark: string | null;
  /** The update finding that was current when `/updatefirstmate` last ran. */
  updateDone: string | null;
  updateHint: string | null;
  updateHintAt: number;
  backpassHint: string | null;
  backpassHintAt: number;
  snoozeUntil: number;
  retryAfter: number;
  failures: number;
}
export function initialFirstmateState(): FirstmateState {
  return {
    version: 1,
    lastSettled: null,
    completed: 0,
    stowMark: null,
    stowCompleted: null,
    stowBaseline: null,
    stowDue: false,
    stowCompactionHeld: false,
    stowHintKey: null,
    updateMark: null,
    updateDone: null,
    updateHint: null,
    updateHintAt: 0,
    backpassHint: null,
    backpassHintAt: 0,
    snoozeUntil: 0,
    retryAfter: 0,
    failures: 0,
  };
}
/** Field types of a persisted state; `?` admits null. Anything else restores the initial state. */
const STATE_FIELDS: Record<
  keyof FirstmateState,
  "1" | "count" | "number" | "boolean" | "string?" | "number?"
> = {
  version: "1",
  lastSettled: "string?",
  completed: "count",
  stowMark: "string?",
  stowCompleted: "number?",
  stowBaseline: "number?",
  stowDue: "boolean",
  stowCompactionHeld: "boolean",
  stowHintKey: "string?",
  updateMark: "string?",
  updateDone: "string?",
  updateHint: "string?",
  updateHintAt: "count",
  backpassHint: "string?",
  backpassHintAt: "count",
  snoozeUntil: "count",
  retryAfter: "number",
  failures: "count",
};
function fieldValid(kind: (typeof STATE_FIELDS)[keyof FirstmateState], v: unknown): boolean {
  if (kind === "1") return v === 1;
  if (kind === "count") return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (kind === "boolean") return typeof v === "boolean";
  if (v === null && kind.endsWith("?")) return true;
  if (kind.startsWith("number")) return typeof v === "number" && Number.isFinite(v);
  return typeof v === "string";
}
export function restoreFirstmateState(branch: readonly SessionEntry[]): FirstmateState {
  const entry = [...branch]
    .reverse()
    .find((e) => e.type === "custom" && e.customType === FIRSTMATE_STATE_TYPE);
  if (entry?.type !== "custom") return initialFirstmateState();
  const data: unknown = entry.data;
  if (!data || typeof data !== "object") return initialFirstmateState();
  const fields = Object.entries(STATE_FIELDS) as [
    keyof FirstmateState,
    (typeof STATE_FIELDS)[keyof FirstmateState],
  ][];
  const record = data as Record<string, unknown>;
  if (!fields.every(([key, kind]) => fieldValid(kind, record[key]))) return initialFirstmateState();
  return { ...(data as FirstmateState) };
}

/** Text of a user message entry, or undefined for any other entry. */
function userText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
}

/** The latest user entry that ran `command` (typed, or sent by the adviser), by id. */
export function lastCommand(branch: readonly SessionEntry[], command: string): string | null {
  const pattern = new RegExp(`^/(?:skill:)?${command.slice(1)}(?:\\s|$)`);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as SessionEntry;
    const text = userText(entry);
    if (text !== undefined && pattern.test(text.trim())) return entry.id;
  }
  return null;
}

/** New `/stow` and `/updatefirstmate` runs reset what they satisfy. */
export function observeCommands(
  s: FirstmateState,
  branch: readonly SessionEntry[],
  tokens: number | undefined,
  finding: string | undefined,
): FirstmateState {
  let next = s;
  const stow = lastCommand(branch, STOW_COMMAND);
  if (stow !== null && stow !== s.stowMark)
    next = {
      ...next,
      stowMark: stow,
      stowCompleted: next.completed,
      stowBaseline: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null,
      stowDue: false,
      stowCompactionHeld: false,
      stowHintKey: null,
    };
  const update = lastCommand(branch, UPDATE_COMMAND);
  if (update !== null && update !== s.updateMark)
    next = { ...next, updateMark: update, updateDone: finding ?? next.updateDone };
  return next;
}

/** Exchanges and new tokens a session needs after `/stow` before it is judged again. */
export const STOW_COOLDOWN_EXCHANGES = 3;
export const STOW_COOLDOWN_TOKENS = 10000;

export function stowCooldown(s: FirstmateState, tokens: number, now: number): string | undefined {
  if (now < s.retryAfter) return "TypeSafe backoff";
  if (s.completed < s.snoozeUntil) return "Snoozed";
  if (s.stowCompleted !== null && s.completed - s.stowCompleted < STOW_COOLDOWN_EXCHANGES)
    return "Waiting for 3 completed exchanges after /stow";
  if (s.stowBaseline !== null && tokens - s.stowBaseline < STOW_COOLDOWN_TOKENS)
    return "Waiting for 10k new tokens after /stow";
  return undefined;
}

/** A deterministic hint is shown again for the same finding only after this many exchanges. */
export const REPEAT_HINT_EXCHANGES = 10;

export function repeatHint(
  s: FirstmateState,
  key: string,
  last: string | null,
  at: number,
): boolean {
  return (
    s.completed >= s.snoozeUntil && (last !== key || s.completed - at >= REPEAT_HINT_EXCHANGES)
  );
}

export interface BackpassCounts {
  sessions: number;
  commits: number | undefined;
}

/** A repository is due once either count crosses its threshold. */
export function backpassDue(
  counts: BackpassCounts,
  settings: FirstmateSettings["backpass"],
): boolean {
  return counts.sessions >= settings.minSessions || (counts.commits ?? 0) >= settings.minCommits;
}

/** Repositories with no recorded round count from a week back, like the weekly job did. */
export const BACKPASS_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
