// Host wiring for the firstmate advisers: stow (TypeSafe-judged), update and backpass
// (deterministic). Inert outside a firstmate home; see docs/adr/001-firstmate-advisers.md.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { savedApiKey } from "./adviser.ts";
import { ConfigStore, type Mode, parseMinimum } from "./config.ts";
import { snapshot } from "./context.ts";
import { DISABLE_ENV, disabledByEnv } from "./disable.ts";
import { resolveTypesafeApiKey } from "./env.ts";
import {
  commitCount,
  dropBackpassNote,
  type FirstmateHome,
  firstmateHome,
  firstmateUpdate,
  fleetBusy,
  openBackpassRounds,
  registeredRepos,
  sessionCounts,
} from "./firstmate-home.ts";
import {
  ADVISER_DISABLE_ENV,
  ADVISER_KINDS,
  type AdviserKind,
  BACKPASS_DEFAULT_WINDOW_MS,
  BackpassRecordStore,
  backpassDue,
  DEFAULT_FIRSTMATE_SETTINGS,
  FIRSTMATE_STATE_TYPE,
  type FirstmateSettings,
  FirstmateSettingsStore,
  type FirstmateState,
  observeCommands,
  repeatHint,
  restoreFirstmateState,
  STOW_COMMAND,
  stowCooldown,
  UPDATE_COMMAND,
} from "./firstmate-policy.ts";
import {
  contextPressure,
  JUDGE_UNAVAILABLE_MESSAGE,
  JudgeError,
  typesafeEndpoint,
} from "./judge.ts";
import { checkpointAnchor, lastResponse } from "./state.ts";
import { judgeStow, type StowJudgment, stowQualifies } from "./stow-judge.ts";

const WIDGET = "compact-adviser:firstmate";
const STOW_HINT = "Stow adviser: this session learned things that are not saved yet. Run /stow.";
const UPDATE_HINT =
  "Update adviser: firstmate has new commits on origin/main and the fleet is idle. Run /updatefirstmate.";
const UPDATE_AFTER_STOW_HINT =
  "Update adviser: firstmate has new commits on origin/main and the fleet is idle. Run /stow first, then /updatefirstmate.";
const USAGE =
  "Use /firstmate-adviser, status, stow|update|backpass auto|hint|off, stow threshold <tokens|default>, backpass sessions|commits <n|default>, snooze or dismiss.";
/** Backpass counting walks session directories and runs git; at most this often. */
const BACKPASS_RECHECK_MS = 30 * 60 * 1000;

const CONFIRM: Record<AdviserKind, [string, string]> = {
  stow: [
    "Enable automatic /stow?",
    "This persists across all sessions in firstmate homes. At a checkpoint judged to hold unsaved knowledge, the adviser sends /stow to the session, and it holds back one manual or threshold compaction to stow first. The judgment is not yet measured.",
  ],
  update: [
    "Enable automatic /updatefirstmate?",
    "This persists across all sessions in a primary firstmate home. When firstmate's update check reports new commits on origin/main, the fleet looks idle, and nothing is left to stow, the adviser sends /updatefirstmate, which fast-forwards firstmate and restarts secondmates.",
  ],
  backpass: [
    "Enable automatic backpass notes?",
    "This persists across all sessions in a primary firstmate home. When repositories pass the backpass thresholds, the adviser drops the backpass-round note into firstmate's inbox, the same note the weekly job drops.",
  ],
};

interface FirstmateOptions {
  agentDir: string;
  key?: () => string | undefined;
  now?: () => number;
  evaluateStow?: (state: unknown, key: string, signal: AbortSignal) => Promise<StowJudgment>;
  commits?: (repo: string, sinceMs: number) => Promise<number | undefined>;
  sessionsDir?: string;
}
export interface FirstmateAdviser {
  /** True when this checkpoint should run `/stow` before any compaction the adviser starts. */
  stowFirst(ctx: ExtensionContext): Promise<boolean>;
}
interface RepoCounts {
  name: string;
  path: string;
  open: boolean;
  sessions: number;
  commits: number | undefined;
}
interface StowOutcome {
  hint: boolean;
  patch: Partial<FirstmateState>;
}

export function installFirstmateAdvisers(
  pi: ExtensionAPI,
  options: FirstmateOptions,
): FirstmateAdviser {
  if (disabledByEnv(process.env[DISABLE_ENV])) return { stowFirst: async () => false };
  const store = new FirstmateSettingsStore(options.agentDir);
  const records = new BackpassRecordStore(options.agentDir);
  const config = new ConfigStore(options.agentDir);
  const now = options.now ?? Date.now;
  const sessionsDir = options.sessionsDir ?? `${options.agentDir}/sessions`;
  const commits = options.commits ?? commitCount;
  const cwds = new Map<string, string | undefined>();
  const key = (cwd: string) =>
    (options.key
      ? options.key()
      : resolveTypesafeApiKey(process.env, cwd, savedApiKey(config)).value
    )?.trim();
  const evaluateStow =
    options.evaluateStow ??
    ((state, key, signal) => {
      const endpoint = typesafeEndpoint(process.env.TYPESAFE_BASE);
      if (endpoint === undefined) return Promise.reject(new JudgeError("configuration"));
      return judgeStow(state, key, signal, undefined, undefined, endpoint);
    });
  let generation = 0;
  let running = false;
  let sawSettled = false;
  let visible = false;
  let diagnostic = "";
  let request: AbortController | undefined;
  let stowJudgment: Promise<boolean> | undefined;
  let backpassCache: { at: number; root: string; repos: RepoCounts[] } | undefined;

  const active = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;
  const mode = (settings: FirstmateSettings, kind: AdviserKind): Mode =>
    disabledByEnv(process.env[ADVISER_DISABLE_ENV[kind]]) ? "off" : settings[kind].mode;
  function persist(state: FirstmateState) {
    pi.appendEntry(FIRSTMATE_STATE_TYPE, state);
  }
  function notice(ctx: ExtensionContext, message: string) {
    if (!active(ctx) || diagnostic === message) return;
    diagnostic = message;
    ctx.ui.notify(message, "warning");
  }
  function invalidate(ctx: ExtensionContext) {
    generation++;
    request?.abort();
    request = undefined;
    if (visible && active(ctx)) ctx.ui.setWidget(WIDGET, undefined);
    visible = false;
  }
  function sessionIdentity(ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    return JSON.stringify([sm.getSessionId(), checkpointAnchor(sm.getBranch())]);
  }
  function send(ctx: ExtensionContext, text: string) {
    if (ctx.isIdle()) pi.sendUserMessage(text);
    else pi.sendUserMessage(text, { deliverAs: "followUp" });
  }
  function budget(): number {
    try {
      return config.read().contextBudgetTokens;
    } catch {
      return 0;
    }
  }

  async function judgeStowStep(
    ctx: ExtensionContext,
    settings: FirstmateSettings,
    s: FirstmateState,
    tokens: number | undefined,
  ): Promise<StowOutcome> {
    const none: StowOutcome = { hint: false, patch: {} };
    const apiKey = key(ctx.cwd);
    if (
      mode(settings, "stow") === "off" ||
      !apiKey ||
      tokens === undefined ||
      tokens < settings.stow.minContextTokens ||
      stowCooldown(s, tokens, now())
    )
      return none;
    const view = snapshot(ctx, [apiKey, savedApiKey(config)]);
    if (view.checkpointKey === s.stowHintKey) return none;
    const controller = new AbortController();
    request = controller;
    try {
      const result = await evaluateStow(view.state, apiKey, controller.signal);
      const usage = ctx.getContextUsage();
      const due = stowQualifies(
        result,
        contextPressure(tokens, usage?.contextWindow ?? Number.NaN, budget()),
      );
      return {
        hint: due,
        patch: {
          stowDue: due,
          stowCompactionHeld: due && s.stowCompactionHeld,
          stowHintKey: due ? view.checkpointKey : s.stowHintKey,
          failures: 0,
          retryAfter: 0,
        },
      };
    } catch (error) {
      if (controller.signal.aborted) return none;
      const failures = Math.min(s.failures + 1, 6);
      notice(ctx, error instanceof JudgeError ? error.message : JUDGE_UNAVAILABLE_MESSAGE);
      return {
        hint: false,
        patch: { failures, retryAfter: now() + Math.min(300000, 5000 * 2 ** failures) },
      };
    } finally {
      if (request === controller) request = undefined;
    }
  }

  /** Per-repository counts since each repository's last round; records rounds seen open. */
  async function backpassCounts(home: FirstmateHome): Promise<RepoCounts[]> {
    const repos = registeredRepos(home);
    const open = openBackpassRounds(home);
    const record = records.read();
    const rounds = { ...(record.homes[home.root] ?? {}) };
    let changed = false;
    for (const [path, started] of open)
      if ((rounds[path] ?? 0) < started) {
        rounds[path] = started;
        changed = true;
      }
    if (changed) records.update({ homes: { ...records.read().homes, [home.root]: rounds } });
    const since = new Map(
      repos.map((r) => [r.path, rounds[r.path] ?? now() - BACKPASS_DEFAULT_WINDOW_MS]),
    );
    const sessions = sessionCounts(sessionsDir, repos, since, cwds);
    const counts = await Promise.all(repos.map((r) => commits(r.path, since.get(r.path) ?? 0)));
    return repos.map((r, i) => ({
      name: r.name,
      path: r.path,
      open: open.has(r.path),
      sessions: sessions.get(r.path) ?? 0,
      commits: counts[i],
    }));
  }
  async function dueRepos(home: FirstmateHome, settings: FirstmateSettings) {
    if (
      !backpassCache ||
      backpassCache.root !== home.root ||
      now() - backpassCache.at >= BACKPASS_RECHECK_MS
    )
      backpassCache = { at: now(), root: home.root, repos: await backpassCounts(home) };
    return backpassCache.repos.filter((r) => !r.open && backpassDue(r, settings.backpass));
  }
  async function recordRounds(home: FirstmateHome, paths: readonly string[]) {
    const homes = records.read().homes;
    const rounds = { ...(homes[home.root] ?? {}) };
    for (const path of paths) rounds[path] = now();
    records.update({ homes: { ...homes, [home.root]: rounds } });
    backpassCache = undefined;
  }

  async function settle(ctx: ExtensionContext) {
    if (!active(ctx) || running) return;
    const home = firstmateHome(ctx.cwd);
    if (!home || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.ui.getEditorText?.().trim())
      return;
    const branch = ctx.sessionManager.getBranch();
    const last = lastResponse(branch);
    let s = restoreFirstmateState(branch);
    if (last?.message.stopReason !== "stop" || s.lastSettled === last.id) return;
    let settings: FirstmateSettings;
    try {
      settings = store.read();
    } catch (error) {
      notice(
        ctx,
        error instanceof Error ? error.message : "Cannot read firstmate adviser settings.",
      );
      return;
    }
    running = true;
    try {
      const raw = ctx.getContextUsage()?.tokens;
      const tokens = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
      const finding = home.primary ? firstmateUpdate(home, now()) : undefined;
      s = observeCommands(
        { ...s, lastSettled: last.id, completed: s.completed + 1 },
        branch,
        tokens,
        finding,
      );
      persist(s);
      const epoch = generation,
        identity = sessionIdentity(ctx);
      const current = () => generation === epoch && sessionIdentity(ctx) === identity;
      const stowStep = judgeStowStep(ctx, settings, s, tokens);
      const before = s.stowDue;
      stowJudgment = stowStep.then(
        (o) => o.patch.stowDue ?? before,
        () => before,
      );
      const backpassOn = home.primary && mode(settings, "backpass") !== "off";
      const [stow, due] = await Promise.all([
        stowStep,
        backpassOn ? dueRepos(home, settings).catch(() => []) : Promise.resolve([]),
      ]);
      if (!current()) return;
      s = { ...s, ...stow.patch };
      const lines: string[] = [];
      let sent = false;
      const auto = (kind: AdviserKind) =>
        mode(settings, kind) === "auto" && settings[kind].autoAcknowledged;

      if (stow.hint && s.completed >= s.snoozeUntil) {
        if (auto("stow")) {
          send(ctx, STOW_COMMAND);
          sent = true;
          ctx.ui.notify("Stow adviser: running /stow at a checkpoint (auto).", "info");
        } else lines.push(STOW_HINT);
      }

      const updateOn = home.primary && mode(settings, "update") !== "off";
      if (updateOn && finding && finding !== s.updateDone && !sent && !fleetBusy(home)) {
        if (s.stowDue) {
          const hintKey = `stow-first:${finding}`;
          if (repeatHint(s, hintKey, s.updateHint, s.updateHintAt)) {
            lines.push(UPDATE_AFTER_STOW_HINT);
            s = { ...s, updateHint: hintKey, updateHintAt: s.completed };
          }
        } else if (auto("update")) {
          send(ctx, UPDATE_COMMAND);
          sent = true;
          s = { ...s, updateDone: finding };
          ctx.ui.notify("Update adviser: running /updatefirstmate (auto).", "info");
        } else if (repeatHint(s, finding, s.updateHint, s.updateHintAt)) {
          lines.push(UPDATE_HINT);
          s = { ...s, updateHint: finding, updateHintAt: s.completed };
        }
      }

      if (due.length) {
        const names = due.map((r) => r.name);
        if (auto("backpass")) {
          try {
            await dropBackpassNote(home, names, new Date(now()));
            await recordRounds(
              home,
              due.map((r) => r.path),
            );
            ctx.ui.notify(
              `Backpass adviser: asked firstmate for a backpass round (${names.join(", ")}).`,
              "info",
            );
          } catch {
            notice(
              ctx,
              "Backpass adviser could not drop the firstmate inbox note; no round recorded.",
            );
          }
        } else {
          const hintKey = names.join(",");
          if (repeatHint(s, hintKey, s.backpassHint, s.backpassHintAt)) {
            lines.push(
              `Backpass adviser: ${names.join(", ")} ${names.length === 1 ? "has" : "have"} enough new sessions or commits since the last backpass round. Ask firstmate to run one.`,
            );
            s = { ...s, backpassHint: hintKey, backpassHintAt: s.completed };
          }
        }
      }

      persist(s);
      if (!lines.length || !current()) return;
      diagnostic = "";
      ctx.ui.setWidget(
        WIDGET,
        (_tui, theme) => new Text(lines.map((line) => theme.fg("warning", line)).join("\n"), 0, 0),
      );
      visible = true;
    } finally {
      running = false;
    }
  }

  const onSettled = (ctx: ExtensionContext) =>
    void settle(ctx).catch(() =>
      notice(ctx, "Firstmate adviser could not inspect this checkpoint; nothing was changed."),
    );
  pi.on("agent_settled", (_event, ctx) => {
    sawSettled = true;
    onSettled(ctx);
  });
  // omp has no agent_settled; its final agent_end (no scheduled continuation) is the boundary.
  // omp still reports the session busy while agent_end handlers run, so wait for idle (<= 5 s).
  pi.on("agent_end", (event, ctx) => {
    if (sawSettled || ("willContinue" in event && event.willContinue === true)) return;
    const epoch = generation;
    const attempt = (left: number) => {
      if (sawSettled || generation !== epoch) return;
      if (ctx.isIdle()) onSettled(ctx);
      else if (left > 0) setTimeout(attempt, 50, left - 1);
    };
    attempt(100);
  });
  pi.on("input", (_event, ctx) => invalidate(ctx));
  pi.on("before_agent_start", (_event, ctx) => invalidate(ctx));
  pi.on("session_start", (_event, ctx) => invalidate(ctx));
  pi.on("session_before_switch", (_event, ctx) => invalidate(ctx));
  pi.on("session_before_fork", (_event, ctx) => invalidate(ctx));
  pi.on("session_before_tree", (_event, ctx) => invalidate(ctx));
  pi.on("session_tree", (_event, ctx) => invalidate(ctx));
  pi.on("session_shutdown", (_event, ctx) => invalidate(ctx));
  pi.on("session_compact", (_event, ctx) => {
    invalidate(ctx);
    if (!active(ctx) || !firstmateHome(ctx.cwd)) return;
    const s = restoreFirstmateState(ctx.sessionManager.getBranch());
    // The context shrank; a pre-compaction token baseline would hold stow advice back for long.
    if (s.stowBaseline !== null) persist({ ...s, stowBaseline: null });
  });
  pi.on("session_before_compact", (event, ctx) => {
    invalidate(ctx);
    if (!active(ctx) || !firstmateHome(ctx.cwd)) return;
    const s = restoreFirstmateState(ctx.sessionManager.getBranch());
    if (!s.stowDue || s.stowCompactionHeld) return;
    let settings: FirstmateSettings;
    try {
      settings = store.read();
    } catch {
      return;
    }
    const stowMode = mode(settings, "stow");
    if (stowMode === "off") return;
    persist({ ...s, stowCompactionHeld: true });
    // Never hold back overflow or retry recovery: the turn cannot continue without it.
    const holdable =
      ["manual", "threshold", "idle"].includes(String(event.reason)) && event.willRetry !== true;
    if (holdable && stowMode === "auto" && settings.stow.autoAcknowledged) {
      setImmediate(() => send(ctx, STOW_COMMAND));
      ctx.ui.notify(
        "Stow adviser: running /stow before compacting. Compact again once it finishes.",
        "info",
      );
      return { cancel: true };
    }
    notice(
      ctx,
      "Stow adviser: this session holds knowledge that is not saved yet, and it is compacting before /stow ran.",
    );
    return undefined;
  });

  function save(ctx: ExtensionContext, settings: FirstmateSettings, message: string) {
    invalidate(ctx);
    store.update(settings);
    diagnostic = "";
    ctx.ui.notify(message, "info");
  }
  async function changeMode(ctx: ExtensionCommandContext, kind: AdviserKind, next: Mode) {
    const settings = store.read();
    if (next === "auto" && !settings[kind].autoAcknowledged) {
      const [title, body] = CONFIRM[kind];
      if (!(await ctx.ui.confirm(title, body))) return;
    }
    save(
      ctx,
      {
        ...settings,
        [kind]: {
          ...settings[kind],
          mode: next,
          autoAcknowledged: settings[kind].autoAcknowledged || next === "auto",
        },
      },
      `${kind[0]?.toUpperCase()}${kind.slice(1)} adviser: ${next === "auto" ? "automatic" : next === "hint" ? "hints only" : "off"} (saved for all sessions).`,
    );
  }
  async function status(ctx: ExtensionCommandContext) {
    const home = firstmateHome(ctx.cwd);
    const settings = store.read();
    const describe = (kind: AdviserKind) =>
      disabledByEnv(process.env[ADVISER_DISABLE_ENV[kind]])
        ? `off (${ADVISER_DISABLE_ENV[kind]})`
        : settings[kind].mode;
    if (!home) {
      ctx.ui.notify(
        `Not a firstmate home: the stow, update and backpass advisers are inert here. Modes: stow ${describe("stow")}, update ${describe("update")}, backpass ${describe("backpass")}. Settings: ${store.path}`,
        "info",
      );
      return;
    }
    const s = restoreFirstmateState(ctx.sessionManager.getBranch());
    const tokens = ctx.getContextUsage()?.tokens;
    const parts = [
      `Firstmate home: ${home.root} (${home.primary ? "primary" : "secondmate"}).`,
      `Stow: ${describe("stow")}. ${s.stowDue ? "The last judged checkpoint holds unsaved knowledge." : "Nothing judged unsaved."}${typeof tokens === "number" ? ` ${stowCooldown(s, tokens, now()) ?? "No cooldown"}.` : ""} Key: ${key(ctx.cwd) ? "present" : "missing"}.`,
    ];
    if (home.primary) {
      const finding = firstmateUpdate(home, now());
      const busy = fleetBusy(home);
      parts.push(
        `Update: ${describe("update")}. ${finding ? `${finding}.` : "No firstmate update reported."}${finding && finding === s.updateDone ? " Already run for this update." : ""}${busy ? ` Waiting: ${busy}.` : ""}`,
      );
      const repos = await backpassCounts(home);
      const due = repos.filter((r) => !r.open && backpassDue(r, settings.backpass));
      parts.push(
        `Backpass: ${describe("backpass")}. Due at ${settings.backpass.minSessions} sessions or ${settings.backpass.minCommits} commits since the last round. ${repos.length ? repos.map((r) => `${r.name} ${r.open ? "round open" : `${r.sessions} sessions/${r.commits ?? "?"} commits`}`).join("; ") : "No registered projects"}. ${due.length ? `Due: ${due.map((r) => r.name).join(", ")}.` : "None due."}`,
      );
    }
    parts.push(`Settings: ${store.path}`);
    ctx.ui.notify(parts.join(" "), "info");
  }
  function setCount(
    ctx: ExtensionCommandContext,
    kind: "stow" | "backpass",
    field: "minContextTokens" | "minSessions" | "minCommits",
    text: string,
    fallback: number,
  ) {
    const value = text === "default" ? fallback : parseMinimum(text);
    const settings = store.read();
    save(
      ctx,
      { ...settings, [kind]: { ...settings[kind], [field]: value } },
      `${kind === "stow" ? "Stow minimum context" : field === "minSessions" ? "Backpass session threshold" : "Backpass commit threshold"} saved: ${value.toLocaleString("en-US")} (all sessions).`,
    );
  }

  pi.registerCommand("firstmate-adviser", {
    description: "Firstmate advisers: when to /stow, /updatefirstmate, and run a backpass round",
    getArgumentCompletions: (prefix) =>
      [
        "status",
        ...ADVISER_KINDS.flatMap((k) => ["auto", "hint", "off"].map((m) => `${k} ${m}`)),
        "stow threshold ",
        "backpass sessions ",
        "backpass commits ",
        "snooze",
        "dismiss",
      ]
        .filter((v) => v.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!active(ctx)) return;
      try {
        const [command, sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const value = rest.join(" ");
        if (!command || (command === "status" && !sub)) await status(ctx);
        else if (
          ADVISER_KINDS.includes(command as AdviserKind) &&
          ["auto", "hint", "off"].includes(sub ?? "") &&
          !value
        )
          await changeMode(ctx, command as AdviserKind, sub as Mode);
        else if (command === "stow" && sub === "threshold" && value)
          setCount(
            ctx,
            "stow",
            "minContextTokens",
            value,
            DEFAULT_FIRSTMATE_SETTINGS.stow.minContextTokens,
          );
        else if (command === "backpass" && sub === "sessions" && value)
          setCount(
            ctx,
            "backpass",
            "minSessions",
            value,
            DEFAULT_FIRSTMATE_SETTINGS.backpass.minSessions,
          );
        else if (command === "backpass" && sub === "commits" && value)
          setCount(
            ctx,
            "backpass",
            "minCommits",
            value,
            DEFAULT_FIRSTMATE_SETTINGS.backpass.minCommits,
          );
        else if ((command === "snooze" || command === "dismiss") && !sub) {
          const s = restoreFirstmateState(ctx.sessionManager.getBranch());
          invalidate(ctx);
          persist(
            command === "snooze"
              ? { ...s, snoozeUntil: s.completed + 4 }
              : { ...s, updateHintAt: s.completed, backpassHintAt: s.completed },
          );
          ctx.ui.notify(
            command === "snooze"
              ? "Firstmate advice snoozed for three completed exchanges."
              : "Firstmate hints dismissed.",
            "info",
          );
        } else throw new Error(USAGE);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not save settings.", "error");
      }
    },
  });

  return {
    async stowFirst(ctx) {
      if (!firstmateHome(ctx.cwd)) return false;
      if (stowJudgment) return stowJudgment;
      return restoreFirstmateState(ctx.sessionManager.getBranch()).stowDue;
    },
  };
}
