import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  commitCount,
  dropBackpassNote,
  type FirstmateHome,
  firstmateHome,
  firstmateUpdate,
  fleetBusy,
  isoWeek,
  laneEvents,
  openBackpassRounds,
  registeredRepos,
  repoForCwd,
  sessionCounts,
} from "../src/firstmate-home.ts";
import {
  backpassDue,
  DEFAULT_FIRSTMATE_SETTINGS,
  FIRSTMATE_STATE_TYPE,
  FirstmateSettingsStore,
  initialFirstmateState,
  lastCommand,
  observeCommands,
  restoreFirstmateState,
  stowCooldown,
} from "../src/firstmate-policy.ts";
import { QUESTIONS } from "../src/judge.ts";
import {
  judgeStow,
  parseStowJudgment,
  STOW_QUESTIONS,
  stowQualifies,
  stowRequestBody,
  stowScore,
} from "../src/stow-judge.ts";
import { fakeHome, gitRepo, lane, put, stowResponse, toolUpdates } from "./firstmate-fixtures.ts";
import { temp } from "./helpers.ts";

test("a firstmate home is recognised only at its own root, with every marker present", (t) => {
  const root = fakeHome(t);
  assert.deepEqual(firstmateHome(root)?.primary, true);
  assert.equal(firstmateHome(join(root, "state")), undefined, "a subdirectory is not the home");
  mkdirSync(join(root, "projects", "repo"), { recursive: true });
  assert.equal(firstmateHome(join(root, "projects", "repo")), undefined);
  assert.equal(firstmateHome(temp(t)), undefined, "an ordinary directory is inert");
  const partial = fakeHome(t);
  writeFileSync(join(partial, ".agents", "skills", "stow", "SKILL.md"), "");
  execFileSync("rm", [join(partial, "bin", "fm-update.sh")]);
  assert.equal(firstmateHome(partial), undefined, "a missing marker is not a home");
  assert.equal(
    firstmateHome(fakeHome(t, true))?.primary,
    false,
    "a secondmate home is not primary",
  );
});

test("the update finding comes only from a fresh, well-formed tool-update cache", (t) => {
  const root = fakeHome(t);
  const home = firstmateHome(root) as FirstmateHome;
  const now = 1_800_000_000_000;
  assert.equal(firstmateUpdate(home, now), undefined, "no cache, no update");
  const finding =
    "firstmate update available: origin/main is at e31bc6e620ca which this copy does not have";
  toolUpdates(root, now / 1000 - 600, `omp update available: New version; ${finding}`);
  assert.equal(firstmateUpdate(home, now), finding);
  toolUpdates(root, now / 1000 - 3 * 3600, finding);
  assert.equal(firstmateUpdate(home, now), undefined, "a stale cache says nothing");
  toolUpdates(root, now / 1000, "omp update available: New version");
  assert.equal(firstmateUpdate(home, now), undefined, "other tools do not count");
  put(
    join(root, "state", ".tool-updates"),
    `fm-tool-updates-v2\nepoch=${now / 1000}\nreported=${finding}\n`,
  );
  assert.equal(firstmateUpdate(home, now), undefined, "an unknown schema says nothing");
});

test("status logs parse tagged events and skip continuation prose", () => {
  const events = laneEvents(
    [
      "working [at=10]: setup done",
      "  continuation prose that is not an event",
      "needs-decision [key=board-review] [at=20]: http://x - 4 edits",
      "paused [at=30] [key=box]: final verification run in progress",
      "blocked: legacy untagged line",
    ].join("\n"),
  );
  assert.deepEqual(
    events.map((e) => [e.state, e.at]),
    [
      ["working", 10],
      ["needs-decision", 20],
      ["paused", 30],
      ["blocked", undefined],
    ],
  );
  assert.equal(events[2]?.text, "final verification run in progress");
});

test("the fleet is busy during a live merge, hardware window, release, or validation pause", (t) => {
  const root = fakeHome(t);
  const home = firstmateHome(root) as FirstmateHome;
  assert.equal(fleetBusy(home), undefined);
  lane(root, "plain-a1", "working [at=1]: implementing the parser\n");
  lane(root, "old-b1", "paused [at=1]: validation run in progress\ndone [at=2]: PR https://x\n");
  put(join(root, "state", "gone-c1.status"), "paused [at=1]: release in progress\n");
  assert.equal(
    fleetBusy(home),
    undefined,
    "working lanes, finished lanes and torn-down lanes do not block",
  );

  put(join(root, "state", ".control-plain-a1.lock", "pid"), "999999\n");
  assert.equal(
    fleetBusy(home, () => false),
    undefined,
    "a stale merge lock does not block",
  );
  assert.match(fleetBusy(home, (pid) => pid === 999999) ?? "", /merge is in flight \(plain-a1\)/);
  execFileSync("rm", ["-r", join(root, "state", ".control-plain-a1.lock")]);

  lane(root, "hw-node-upgrade-h1", "working [at=1]: draining services\n");
  assert.match(fleetBusy(home) ?? "", /hardware window/);
  execFileSync("rm", [join(root, "state", "hw-node-upgrade-h1.meta")]);
  lane(root, "ops-r1", "working [at=1]: cutting the v1.4 release\n");
  assert.match(fleetBusy(home) ?? "", /release is in flight \(ops-r1\)/);
  execFileSync("rm", [join(root, "state", "ops-r1.meta")]);
  lane(root, "ship-v1", "paused [at=5]: final verification run in progress\n");
  assert.match(fleetBusy(home) ?? "", /mid-validation \(ship-v1\)/);
  execFileSync("rm", [join(root, "state", "ship-v1.meta")]);

  const mate = fakeHome(t, true);
  put(join(root, "data", "secondmates.md"), `- sm-x - scope (home: ${mate}; scope: x)\n`);
  lane(mate, "mate-v1", "paused [at=5]: pipeline checks running\n");
  assert.match(fleetBusy(home) ?? "", /mid-validation \(mate-v1\)/, "secondmate lanes count");
});

test("registered repos, open backpass rounds and per-repo session counts", (t) => {
  const root = fakeHome(t);
  const home = firstmateHome(root) as FirstmateHome;
  const outside = temp(t);
  const app = join(outside, "app");
  const nested = join(app, "modules", "lib");
  gitRepo(app, 1);
  gitRepo(nested, 1);
  mkdirSync(join(root, "projects"), { recursive: true });
  symlinkSync(app, join(root, "projects", "app"));
  symlinkSync(nested, join(root, "projects", "lib"));
  symlinkSync(join(outside, "missing"), join(root, "projects", "dangling"));
  const repos = registeredRepos(home);
  assert.deepEqual(
    repos.map((r) => r.name),
    ["app", "lib"],
  );

  lane(
    root,
    "bp-w40-app",
    "working [at=1790000000]: started\npaused [at=1790000100]: board awaiting review\n",
    `project=${join(root, "projects", "app")}\n`,
  );
  lane(root, "ship-a1", "working [at=1]: x\n", `project=${app}\n`);
  assert.deepEqual([...openBackpassRounds(home)], [[repos[0]?.path, 1790000000 * 1000]]);

  assert.equal(repoForCwd(join(nested, "src"), repos)?.name, "lib", "the deepest checkout wins");
  const worktree = join(outside, "wt");
  put(join(worktree, ".git"), `gitdir: ${join(repos[0]?.path ?? "", ".git", "worktrees", "wt")}\n`);
  assert.equal(repoForCwd(worktree, repos)?.name, "app", "a worktree belongs to its repository");
  assert.equal(repoForCwd("/x/orca/workspaces/app/fm-gone-a1", repos)?.name, "app", "Orca layout");
  assert.equal(repoForCwd("/x/elsewhere", repos), undefined);

  const sessions = join(outside, "sessions");
  const session = (dir: string, cwd: string, stamp: string) =>
    put(
      join(sessions, dir, `${stamp}_01a0.jsonl`),
      `${JSON.stringify({ type: "title" })}\n${JSON.stringify({ type: "session", version: 3, cwd })}\n`,
    );
  session("-app", app, "2026-10-01T10-00-00-000Z");
  session("-app", app, "2026-10-02T10-00-00-000Z");
  session("-app", app, "2026-09-01T10-00-00-000Z");
  session("-wt", worktree, "2026-10-02T11-00-00-000Z");
  session("-lib", nested, "2026-10-02T12-00-00-000Z");
  session("-other", "/x/elsewhere", "2026-10-02T12-00-00-000Z");
  const since = new Map([
    [repos[0]?.path as string, Date.parse("2026-09-30T00:00:00Z")],
    [repos[1]?.path as string, Date.parse("2026-10-03T00:00:00Z")],
  ]);
  const counts = sessionCounts(sessions, repos, since);
  assert.equal(counts.get(repos[0]?.path as string), 3, "two in the checkout, one in a worktree");
  assert.equal(counts.get(repos[1]?.path as string), 0, "nothing since the nested repo's round");
});

test("commit counts read local refs since a time", async (t) => {
  const repo = join(temp(t), "repo");
  gitRepo(repo, 3, "2026-10-01T12:00:00Z");
  assert.equal(await commitCount(repo, Date.parse("2026-09-30T00:00:00Z")), 3);
  assert.equal(await commitCount(repo, Date.parse("2026-10-02T00:00:00Z")), 0);
  assert.equal(await commitCount(join(temp(t), "not-a-repo"), 0), undefined);
});

test("ISO weeks match date +%G-%V, including year boundaries", () => {
  const cases: [number, number, number, number, number][] = [
    [2026, 1, 1, 2026, 1],
    [2027, 1, 1, 2026, 53],
    [2026, 10, 3, 2026, 40],
    [2026, 12, 28, 2026, 53],
    [2025, 12, 29, 2026, 1],
  ];
  for (const [y, m, d, year, week] of cases)
    assert.deepEqual(isoWeek(new Date(y, m - 1, d, 12)), { year, week }, `${y}-${m}-${d}`);
});

test("a backpass note goes through firstmate's own inbox command, idempotently keyed", async (t) => {
  const root = fakeHome(t);
  await dropBackpassNote(
    firstmateHome(root) as FirstmateHome,
    ["app", "lib"],
    new Date(2026, 9, 3, 12),
  );
  const lines = readFileSync(join(root, "state", "inbox-calls.log"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines[0], `FM_HOME=${firstmateHome(root)?.root}`);
  assert.deepEqual(lines.slice(1, 5), [
    "note",
    "--request-id",
    "backpass-adviser-2026-w40-app.lib",
    "--",
  ]);
  assert.match(
    lines[5] ?? "",
    /^Backpass round is due for app, lib: .*dispatch\.py w40 from the firstmate home/,
  );
});

test("firstmate adviser settings default to hint and reject invalid modes", (t) => {
  const store = new FirstmateSettingsStore(temp(t));
  assert.deepEqual(store.read(), DEFAULT_FIRSTMATE_SETTINGS);
  store.update({
    ...store.read(),
    stow: { ...store.read().stow, mode: "auto", autoAcknowledged: true },
  });
  assert.equal(store.read().stow.mode, "auto");
  assert.equal(store.read().update.mode, "hint", "other advisers keep their own mode");
  writeFileSync(store.path, JSON.stringify({ version: 1, backpass: { minSessions: 3 } }));
  assert.equal(store.read().backpass.minSessions, 3);
  assert.equal(store.read().backpass.minCommits, 20, "missing fields take the defaults");
  writeFileSync(store.path, JSON.stringify({ version: 1, update: { mode: "always" } }));
  assert.throws(() => store.read(), /Cannot read firstmate adviser settings/);
  writeFileSync(store.path, JSON.stringify({ version: 1, backpass: { minCommits: 0 } }));
  assert.throws(() => store.read());
});

test("backpass is due once either count crosses its threshold", () => {
  const settings = DEFAULT_FIRSTMATE_SETTINGS.backpass;
  assert.equal(backpassDue({ sessions: 7, commits: 19 }, settings), false);
  assert.equal(backpassDue({ sessions: 8, commits: 0 }, settings), true);
  assert.equal(backpassDue({ sessions: 0, commits: 20 }, settings), true);
  assert.equal(backpassDue({ sessions: 0, commits: undefined }, settings), false);
});

test("/stow and /updatefirstmate runs are found by exact command, and reset what they satisfy", () => {
  const user = (id: string, text: string) =>
    ({ type: "message", id, message: { role: "user", content: text } }) as never;
  const branch = [user("a", "/stow"), user("b", "please /stow later"), user("c", "/stowaway")];
  assert.equal(lastCommand(branch, "/stow"), "a");
  assert.equal(lastCommand([...branch, user("d", "/skill:stow now")], "/stow"), "d");
  assert.equal(lastCommand(branch, "/updatefirstmate"), null);

  const due = { ...initialFirstmateState(), completed: 5, stowDue: true, stowCompactionHeld: true };
  const after = observeCommands(
    due,
    [user("s", "/stow"), user("u", "/updatefirstmate")],
    50000,
    "f1",
  );
  assert.equal(after.stowDue, false);
  assert.equal(after.stowCompactionHeld, false);
  assert.equal(after.stowCompleted, 5);
  assert.equal(after.stowBaseline, 50000);
  assert.equal(after.updateDone, "f1");
  assert.equal(observeCommands(after, [user("s", "/stow")], 90000, "f2").stowBaseline, 50000);

  assert.equal(
    stowCooldown({ ...after, completed: 7 }, 70000, 0),
    "Waiting for 3 completed exchanges after /stow",
  );
  assert.equal(
    stowCooldown({ ...after, completed: 8 }, 55000, 0),
    "Waiting for 10k new tokens after /stow",
  );
  assert.equal(stowCooldown({ ...after, completed: 8 }, 60000, 0), undefined);
});

test("a malformed persisted firstmate state restores the initial state", () => {
  const custom = (data: unknown) =>
    [{ type: "custom", customType: FIRSTMATE_STATE_TYPE, id: "x", data }] as never;
  const good = { ...initialFirstmateState(), completed: 4, stowDue: true };
  assert.deepEqual(restoreFirstmateState(custom(good)), good);
  assert.deepEqual(
    restoreFirstmateState(custom({ ...good, completed: -1 })),
    initialFirstmateState(),
  );
  assert.deepEqual(
    restoreFirstmateState(custom({ ...good, stowDue: "yes" })),
    initialFirstmateState(),
  );
  assert.deepEqual(restoreFirstmateState(custom(null)), initialFirstmateState());
});

test("the stow judgment reuses the compact done question and slides with the compact floor", async () => {
  assert.equal(JSON.stringify(STOW_QUESTIONS.done), JSON.stringify(QUESTIONS.done));
  const j = parseStowJudgment(stowResponse(0.95, 0.9));
  assert.equal(Math.round(stowScore(j) * 1000) / 1000, 0.855);
  assert.equal(stowQualifies(j, 0.05), false, "below the 0.90 floor while the window is empty");
  assert.equal(stowQualifies(j, 0.5), true, "above the 0.70 floor at half full");
  assert.equal(stowQualifies(parseStowJudgment(stowResponse(0.95, 0.1)), 0.95), false);
  assert.throws(() => parseStowJudgment({ model: "m", answers: { done: {} } }), /TypeSafe|Jev/);
  assert.throws(() => stowRequestBody({ text: "x".repeat(40000) }), /TypeSafe|Jev/);

  let sent: { url: string; body: string; auth: string } | undefined;
  const transport = (async (url: string, init: RequestInit) => {
    sent = {
      url,
      body: String(init.body),
      auth: String((init.headers as Record<string, string>).Authorization),
    };
    return new Response(JSON.stringify(stowResponse(0.9, 0.8)));
  }) as typeof fetch;
  const result = await judgeStow({ recent: [] }, "k", new AbortController().signal, transport);
  assert.equal(result.knowledge.choice, "unsaved");
  assert.equal(sent?.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(sent?.auth, "Bearer k");
  assert.deepEqual(Object.keys(JSON.parse(sent?.body ?? "{}").questions), ["done", "knowledge"]);
  assert.ok(!sent?.body.includes('"k"'), "the key never enters the body");
});

test("a backpass round with no timed status event starts at its meta mtime", (t) => {
  const root = fakeHome(t);
  const app = join(temp(t), "app");
  gitRepo(app, 1);
  lane(root, "bp-x-app", "", `project=${app}\n`);
  utimesSync(join(root, "state", "bp-x-app.meta"), 1790000, 1790000);
  assert.equal(
    openBackpassRounds(firstmateHome(root) as FirstmateHome).get(realpathSync(app)),
    1790000 * 1000,
  );
});
