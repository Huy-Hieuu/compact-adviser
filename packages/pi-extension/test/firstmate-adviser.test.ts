import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  type CompactOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { installAdviser } from "../src/adviser.ts";
import { installFirstmateAdvisers } from "../src/firstmate-adviser.ts";
import { FIRSTMATE_STATE_TYPE, FirstmateSettingsStore } from "../src/firstmate-policy.ts";
import { parseJudgment } from "../src/judge.ts";
import { parseStowJudgment, type StowJudgment } from "../src/stow-judge.ts";
import { fakeHome, gitRepo, lane, stowResponse, toolUpdates } from "./firstmate-fixtures.ts";
import { apiResponse, assistant, flush, temp } from "./helpers.ts";

const STOW_HINT = "Stow adviser: this session learned things that are not saved yet. Run /stow.";
const UPDATE_HINT =
  "Update adviser: firstmate has new commits on origin/main and the fleet is idle. Run /updatefirstmate.";
const UPDATE_AFTER_STOW_HINT =
  "Update adviser: firstmate has new commits on origin/main and the fleet is idle. Run /stow first, then /updatefirstmate.";
const STOW_FIRST_COMPACT_HINT =
  "Compact adviser: work appears completed or recorded. Run /stow first, then /compact to save tokens.";
const FINDING =
  "firstmate update available: origin/main is at e31bc6e620ca which this copy does not have";
const CLOCK = Date.parse("2026-10-03T12:00:00Z");

const unsaved = () => parseStowJudgment(stowResponse(0.99, 0.95));
const nothingNew = () => parseStowJudgment(stowResponse(0.99, 0.02));

function env(t: TestContext, name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function harness(
  t: TestContext,
  options: { cwd?: string; stow?: () => StowJudgment; commits?: Record<string, number> } = {},
) {
  initTheme("dark", false);
  const agentDir = temp(t);
  const cwd = options.cwd ?? fakeHome(t);
  const sm = SessionManager.create(cwd, join(agentDir, "pi-sessions"));
  sm.appendMessage({
    role: "user",
    content: "From now on, always ask before restarting a secondmate.",
    timestamp: 1,
  });
  sm.appendMessage(assistant("Earlier coordination. ".repeat(6000)));
  sm.appendMessage(assistant("Noted: I will ask before restarting a secondmate."));
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const widgets: { key: string; lines: string[] | undefined }[] = [];
  const notifications: string[] = [];
  const sent: string[] = [];
  const confirms: boolean[] = [];
  const compactions: CompactOptions[] = [];
  let tokens = 45000;
  let stowCalls = 0;
  let compactCalls = 0;
  let stow = options.stow ?? unsaved;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: sm,
    model: { id: "fixture", provider: "fixture", contextWindow: 272000 },
    ui: {
      notify: (text: string) => notifications.push(text),
      setWidget: (key: string, content: unknown) => {
        if (typeof content !== "function") {
          widgets.push({ key, lines: content as string[] | undefined });
          return;
        }
        const component = content({}, { fg: (color: string, text: string) => `${color}:${text}` });
        widgets.push({
          key,
          lines: (component.render(400) as string[]).map((line) => line.trim()).filter(Boolean),
        });
      },
      setStatus: () => {},
      getEditorText: () => "",
      confirm: async () => confirms.shift() ?? true,
      select: async () => undefined,
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens, contextWindow: 272000, percent: tokens / 2720 }),
    compact: (o: CompactOptions) => compactions.push(o),
  } as unknown as ExtensionCommandContext;
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, structuredClone(data)),
    registerCommand: (
      name: string,
      o: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => commands.set(name, o.handler),
    // The host appends the prompt as a user message, which is how a sent /stow is observed.
    sendUserMessage: (text: string) => {
      sent.push(text);
      sm.appendMessage({ role: "user", content: text, timestamp: 2 });
    },
  } as unknown as ExtensionAPI;
  const install = () => {
    handlers.clear();
    commands.clear();
    const firstmate = installFirstmateAdvisers(api, {
      agentDir,
      key: () => "test-key",
      now: () => CLOCK,
      evaluateStow: async () => {
        stowCalls++;
        return stow();
      },
      commits: async (repo) => options.commits?.[repo] ?? 0,
      sessionsDir: join(agentDir, "sessions"),
    });
    installAdviser(api, {
      agentDir,
      version: "0.82.0",
      key: () => "test-key",
      now: () => CLOCK,
      evaluate: async () => {
        compactCalls++;
        return parseJudgment(apiResponse());
      },
      stowFirst: firstmate.stowFirst,
    });
  };
  install();
  const fire = async (name: string, event: unknown = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    for (let i = 0; i < 5; i++) await flush();
    return results;
  };
  return {
    agentDir,
    cwd,
    sm,
    sent,
    confirms,
    notifications,
    compactions,
    install,
    fire,
    store: new FirstmateSettingsStore(agentDir),
    next: (text = "Done with that step.") => sm.appendMessage(assistant(text)),
    user: (text: string) => sm.appendMessage({ role: "user", content: text, timestamp: 3 }),
    command: async (args: string) => {
      const handler = commands.get("firstmate-adviser");
      if (!handler) throw new Error("command missing");
      await handler(args, ctx);
    },
    hasCommand: (name: string) => commands.has(name),
    /** Lines of the latest firstmate widget, minus the theme color prefix. */
    firstmateLines: () =>
      widgets
        .filter((w) => w.key === "compact-adviser:firstmate")
        .at(-1)
        ?.lines?.map((line) => line.replace(/^warning:/, "")),
    compactLines: () =>
      widgets
        .filter((w) => w.key === "compact-adviser")
        .at(-1)
        ?.lines?.map((line) => line.replace(/^warning:/, "")),
    set tokens(value: number) {
      tokens = value;
    },
    set stow(judge: () => StowJudgment) {
      stow = judge;
    },
    get stowCalls() {
      return stowCalls;
    },
    get compactCalls() {
      return compactCalls;
    },
  };
}

test("the stow hint fires in a firstmate home and nowhere else", async (t) => {
  const h = harness(t);
  await h.fire("agent_settled");
  assert.equal(h.stowCalls, 1);
  assert.deepEqual(h.firstmateLines(), [STOW_HINT]);
  assert.ok(!h.sent.length, "hint mode never sends anything to the model");

  const elsewhere = harness(t, { cwd: temp(t) });
  await elsewhere.fire("agent_settled");
  assert.equal(elsewhere.stowCalls, 0, "no judgment outside a firstmate home");
  assert.equal(elsewhere.firstmateLines(), undefined);
  assert.ok(
    !elsewhere.sm
      .getEntries()
      .some((e) => e.type === "custom" && e.customType === FIRSTMATE_STATE_TYPE),
    "no session state outside a firstmate home",
  );
});

test("after /stow, stow advice waits for three exchanges and 10k new tokens", async (t) => {
  const h = harness(t);
  await h.fire("agent_settled");
  assert.equal(h.stowCalls, 1);
  h.user("/stow");
  h.next("Stowed two preferences.");
  await h.fire("agent_settled");
  h.next("one");
  await h.fire("agent_settled");
  h.next("two");
  await h.fire("agent_settled");
  h.next("three, but the context has not grown");
  await h.fire("agent_settled");
  assert.equal(h.stowCalls, 1);
  h.tokens = 56000;
  h.next("four, with new material");
  await h.fire("agent_settled");
  assert.equal(h.stowCalls, 2);
});

test("a checkpoint with nothing unsaved stays silent", async (t) => {
  const h = harness(t, { stow: nothingNew });
  await h.fire("agent_settled");
  assert.equal(h.stowCalls, 1);
  assert.equal(h.firstmateLines(), undefined);
});

test("automatic stow asks first, then runs /stow instead of hinting", async (t) => {
  const h = harness(t);
  h.confirms.push(false);
  await h.command("stow auto");
  assert.equal(h.store.read().stow.mode, "hint", "a declined confirmation saves nothing");
  await h.command("stow auto");
  assert.deepEqual(h.store.read().stow, {
    mode: "auto",
    autoAcknowledged: true,
    minContextTokens: 20000,
  });
  await h.fire("agent_settled");
  assert.deepEqual(h.sent, ["/stow"]);
  assert.equal(h.firstmateLines(), undefined);
});

test("COMPACT_ADVISER_DISABLE beats everything; a per-adviser switch silences only that adviser", async (t) => {
  env(t, "COMPACT_ADVISER_DISABLE", "1");
  const off = harness(t);
  assert.equal(off.hasCommand("firstmate-adviser"), false);
  await off.fire("agent_settled");
  assert.equal(off.stowCalls, 0);
  delete process.env.COMPACT_ADVISER_DISABLE;

  env(t, "COMPACT_ADVISER_STOW_DISABLE", "yes");
  const h = harness(t);
  toolUpdates(h.cwd, CLOCK / 1000 - 60, FINDING);
  await h.fire("agent_settled");
  assert.equal(h.stowCalls, 0);
  assert.deepEqual(h.firstmateLines(), [UPDATE_HINT]);
});

test("update advice needs a fresh firstmate finding, an idle fleet, and nothing left to stow", async (t) => {
  const idle = harness(t, { stow: nothingNew });
  toolUpdates(idle.cwd, CLOCK / 1000 - 60, FINDING);
  await idle.fire("agent_settled");
  assert.deepEqual(idle.firstmateLines(), [UPDATE_HINT]);

  const stale = harness(t, { stow: nothingNew });
  toolUpdates(stale.cwd, CLOCK / 1000 - 3 * 3600, FINDING);
  await stale.fire("agent_settled");
  assert.equal(stale.firstmateLines(), undefined);

  const busy = harness(t, { stow: nothingNew });
  toolUpdates(busy.cwd, CLOCK / 1000 - 60, FINDING);
  lane(busy.cwd, "ship-v1", "paused [at=1]: final verification run in progress\n");
  await busy.fire("agent_settled");
  assert.equal(busy.firstmateLines(), undefined);

  const stowFirst = harness(t);
  toolUpdates(stowFirst.cwd, CLOCK / 1000 - 60, FINDING);
  await stowFirst.fire("agent_settled");
  assert.deepEqual(stowFirst.firstmateLines(), [STOW_HINT, UPDATE_AFTER_STOW_HINT]);
});

test("automatic update runs once per finding and never before a due stow", async (t) => {
  const h = harness(t);
  toolUpdates(h.cwd, CLOCK / 1000 - 60, FINDING);
  await h.command("update auto");
  await h.fire("agent_settled");
  assert.deepEqual(h.sent, [], "stow is due, so the update waits");
  h.user("/stow");
  h.next("Stowed.");
  h.stow = nothingNew;
  await h.fire("agent_settled");
  assert.deepEqual(h.sent, ["/updatefirstmate"]);
  h.next("Updated firstmate.");
  await h.fire("agent_settled");
  h.next("Later work.");
  await h.fire("agent_settled");
  assert.deepEqual(h.sent, ["/updatefirstmate"], "the same finding is not run twice");
});

test("a secondmate home gets stow advice but never update or backpass advice", async (t) => {
  const h = harness(t, { cwd: fakeHome(t, true) });
  toolUpdates(h.cwd, CLOCK / 1000 - 60, FINDING);
  await h.fire("agent_settled");
  assert.deepEqual(h.firstmateLines(), [STOW_HINT]);
});

test("stow comes before any compaction the compact adviser would start", async (t) => {
  const hint = harness(t);
  await hint.command("stow hint");
  await hint.fire("agent_settled");
  assert.equal(hint.compactCalls, 1);
  assert.deepEqual(hint.compactLines(), [STOW_FIRST_COMPACT_HINT]);

  const auto = harness(t);
  writeFileSync(
    join(auto.agentDir, "compact-adviser.json"),
    JSON.stringify({ version: 1, mode: "auto", minContextTokens: 40000, autoAcknowledged: true }),
  );
  await auto.fire("agent_settled");
  assert.equal(auto.compactCalls, 1);
  assert.equal(auto.compactions.length, 0, "no automatic compaction while stow is due");

  const outside = harness(t, { cwd: temp(t) });
  await outside.fire("agent_settled");
  assert.equal(
    outside.compactLines()?.[0],
    "Compact adviser: work appears completed or recorded. Run /compact to save tokens.",
  );
});

test("a host compaction with stow due is held once in auto mode, never for overflow", async (t) => {
  const h = harness(t);
  await h.command("stow auto");
  h.stow = unsaved;
  await h.fire("agent_settled");
  assert.deepEqual(h.sent, ["/stow"]);
  // The sent /stow has not settled yet; a threshold compaction arrives first.
  h.sent.length = 0;
  const overflow = await h.fire("session_before_compact", {
    reason: "overflow",
    willRetry: true,
    preparation: { settings: { keepRecentTokens: 20000 } },
  });
  assert.ok(!overflow.some((r) => (r as { cancel?: boolean } | undefined)?.cancel));

  const held = harness(t);
  await held.fire("agent_settled");
  await held.command("stow auto");
  const event = {
    reason: "threshold",
    willRetry: false,
    preparation: { settings: { keepRecentTokens: 20000 } },
  };
  const first = await held.fire("session_before_compact", event);
  assert.ok(first.some((r) => (r as { cancel?: boolean } | undefined)?.cancel));
  await flush();
  assert.deepEqual(held.sent, ["/stow"]);
  const second = await held.fire("session_before_compact", event);
  assert.ok(!second.some((r) => (r as { cancel?: boolean } | undefined)?.cancel), "held only once");

  const warned = harness(t);
  await warned.fire("agent_settled");
  const results = await warned.fire("session_before_compact", event);
  assert.ok(
    !results.some((r) => (r as { cancel?: boolean } | undefined)?.cancel),
    "hint mode never cancels",
  );
  assert.ok(
    warned.notifications.some((n) => n.startsWith("Stow adviser: this session holds knowledge")),
  );
});

function backpassHome(t: TestContext) {
  const cwd = fakeHome(t);
  const repos = temp(t);
  const app = join(repos, "app");
  const lib = join(repos, "lib");
  gitRepo(app, 1);
  gitRepo(lib, 1);
  mkdirSync(join(cwd, "projects"));
  symlinkSync(app, join(cwd, "projects", "app"));
  symlinkSync(lib, join(cwd, "projects", "lib"));
  return { cwd, app: realpathSync(app), lib: realpathSync(lib) };
}
/** The backpass record of the one firstmate home a test uses. */
function rounds(agentDir: string): Record<string, number> {
  const path = join(agentDir, "compact-adviser-backpass.json");
  if (!existsSync(path)) return {};
  const record = JSON.parse(readFileSync(path, "utf8")) as {
    homes: Record<string, Record<string, number>>;
  };
  return Object.values(record.homes)[0] ?? {};
}
function sessions(agentDir: string, cwd: string, n: number) {
  const dir = join(agentDir, "sessions", "-app");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++)
    writeFileSync(
      join(dir, `2026-10-02T10-00-${String(i).padStart(2, "0")}-000Z_s${i}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, cwd })}\n`,
    );
}

test("backpass advice names repos past a threshold, skips open rounds, and records them", async (t) => {
  const { cwd, app, lib } = backpassHome(t);
  const h = harness(t, { cwd, stow: nothingNew, commits: { [lib]: 25 } });
  sessions(h.agentDir, app, 8);
  await h.fire("agent_settled");
  assert.deepEqual(h.firstmateLines(), [
    "Backpass adviser: app, lib have enough new sessions or commits since the last backpass round. Ask firstmate to run one.",
  ]);

  const open = harness(t, { cwd, stow: nothingNew, commits: { [lib]: 25 } });
  sessions(open.agentDir, app, 7);
  lane(cwd, "bp-w40-lib", `working [at=${CLOCK / 1000 - 3600}]: started\n`, `project=${lib}\n`);
  await open.fire("agent_settled");
  assert.equal(
    open.firstmateLines(),
    undefined,
    "seven sessions are below the threshold; lib's round is open",
  );
  assert.equal(rounds(open.agentDir)[lib], CLOCK - 3600 * 1000, "the open round is recorded");
});

test("automatic backpass drops the firstmate inbox note and records the round", async (t) => {
  const { cwd, app } = backpassHome(t);
  const h = harness(t, { cwd, stow: nothingNew });
  sessions(h.agentDir, app, 9);
  await h.command("backpass auto");
  await h.fire("agent_settled");
  const log = join(cwd, "state", "inbox-calls.log");
  // The note goes through a real child process; wait for the round recorded after it.
  for (let i = 0; i < 100000 && rounds(h.agentDir)[app] === undefined; i++) await flush();
  assert.match(
    readFileSync(log, "utf8"),
    /--request-id\nbackpass-adviser-2026-w40-app\n--\nBackpass round is due for app:/,
  );
  assert.equal(rounds(h.agentDir)[app], CLOCK);
  assert.equal(h.firstmateLines(), undefined, "auto drops the note instead of hinting");
});

test("omp's final agent_end stands in for agent_settled, which wins once seen", async (t) => {
  const h = harness(t);
  await h.fire("agent_end", { willContinue: true });
  assert.equal(h.stowCalls, 0, "a scheduled continuation is not a checkpoint");
  await h.fire("agent_end", {});
  assert.equal(h.stowCalls, 1);
  h.next("another answer");
  await h.fire("agent_settled");
  assert.equal(h.stowCalls, 2);
  h.next("and another");
  await h.fire("agent_end", {});
  assert.equal(h.stowCalls, 2, "agent_end is ignored on a host that has agent_settled");
});
