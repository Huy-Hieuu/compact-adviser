import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { lockSync } from "proper-lockfile";
import { parseProfile } from "./profile.ts";

export type Mode = "hint" | "auto" | "off";
export const MAX_SAVED_API_KEY_LENGTH = 1024;
export interface Config {
  version: 1;
  mode: Mode;
  minContextTokens: number;
  /** Tokens at which the hint floor is fully relaxed; 0 uses the model's window. */
  contextBudgetTokens: number;
  autoAcknowledged: boolean;
  logRequests: boolean;
  typesafeApiKey?: string;
  profile?: string;
}
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  version: 1,
  mode: "hint",
  minContextTokens: 40000,
  contextBudgetTokens: 0,
  autoAcknowledged: false,
  logRequests: false,
});
export function parseMinimum(text: string): number {
  const value = text.trim();
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Enter a positive whole number of tokens, for example 40000.");
  }
  return number;
}
/** A context budget in tokens, or 0 for "off" (the model's window). */
export function parseBudget(text: string): number {
  const value = text.trim();
  if (value === "off") return 0;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error("Enter a whole number of tokens, for example 450000, or off.");
  }
  return number;
}
export function parseSavedApiKey(text: string): string {
  const value = text.trim();
  if (!value) throw new Error("Enter a TypeSafe API key, or cancel to leave it unchanged.");
  if (value.length > MAX_SAVED_API_KEY_LENGTH) {
    throw new Error("That value is too long to save as a TypeSafe API key.");
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new Error("The key cannot contain control characters.");
    }
  }
  return value;
}
function validate(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid settings.");
  const c = value as Record<string, unknown>;
  if (
    c.version !== 1 ||
    !["hint", "auto", "off"].includes(String(c.mode)) ||
    typeof c.minContextTokens !== "number" ||
    !Number.isSafeInteger(c.minContextTokens) ||
    c.minContextTokens <= 0 ||
    (c.contextBudgetTokens !== undefined &&
      (typeof c.contextBudgetTokens !== "number" ||
        !Number.isSafeInteger(c.contextBudgetTokens) ||
        c.contextBudgetTokens < 0)) ||
    typeof c.autoAcknowledged !== "boolean" ||
    (c.logRequests !== undefined && typeof c.logRequests !== "boolean") ||
    (c.typesafeApiKey !== undefined && typeof c.typesafeApiKey !== "string")
  ) {
    throw new Error("Invalid or unsupported settings. Restore a valid version-1 configuration.");
  }
  parseProfile(c.profile);
  const typesafeApiKey =
    typeof c.typesafeApiKey === "string" && c.typesafeApiKey.trim() !== ""
      ? c.typesafeApiKey.trim()
      : undefined;
  if (typesafeApiKey !== undefined && typesafeApiKey.length > MAX_SAVED_API_KEY_LENGTH) {
    throw new Error("Invalid or unsupported settings. Restore a valid version-1 configuration.");
  }
  return {
    version: 1,
    mode: c.mode as Mode,
    minContextTokens: c.minContextTokens,
    contextBudgetTokens: (c.contextBudgetTokens as number | undefined) ?? 0,
    autoAcknowledged: c.autoAcknowledged,
    logRequests: c.logRequests === true,
    ...(typesafeApiKey !== undefined ? { typesafeApiKey } : {}),
    ...(c.profile !== undefined ? { profile: c.profile as string } : {}),
  };
}
/**
 * A small owned JSON settings file: size- and symlink-checked reads, a missing file
 * reads as the defaults, and updates are locked, validated, fsynced and renamed.
 */
export class JsonStore<T extends object> {
  readonly path: string;
  readonly #validate: (value: unknown) => T;
  readonly #defaults: Readonly<T>;
  readonly #unreadable: string;
  constructor(
    path: string,
    validate: (value: unknown) => T,
    defaults: Readonly<T>,
    unreadable: string,
  ) {
    this.path = path;
    this.#validate = validate;
    this.#defaults = defaults;
    this.#unreadable = unreadable;
  }
  read(): T {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
        throw new Error("Unsafe settings file.");
      return this.#validate(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(this.#defaults) as T;
      throw new Error(this.#unreadable, { cause: error });
    }
  }
  update(patch: Partial<T>): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // A short cross-process lock serializes read/merge/write. Contention is reported,
    // never hidden by overwriting another session's field update.
    const release = lockSync(this.path, { realpath: false, stale: 10000 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const config = this.#validate({ ...this.read(), ...patch });
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      return config;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // Best-effort cleanup of a preferences-only temporary file; always release the lock.
      }
      release();
    }
  }
}
export class ConfigStore extends JsonStore<Config> {
  constructor(agentDir: string) {
    super(
      join(agentDir, "compact-adviser.json"),
      validate,
      DEFAULT_CONFIG,
      "Cannot read compact-adviser settings; automatic action is disabled.",
    );
  }
}
