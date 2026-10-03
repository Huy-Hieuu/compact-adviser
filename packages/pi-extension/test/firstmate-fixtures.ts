import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { temp } from "./helpers.ts";

export function put(path: string, text = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A directory with every firstmate-home marker; `bin/fm-inbox.sh` logs its arguments. */
export function fakeHome(t: TestContext, secondmate = false): string {
  const root = temp(t);
  put(
    join(root, "bin", "fm-inbox.sh"),
    '#!/bin/sh\nprintf "%s\\n" "FM_HOME=$FM_HOME" "$@" >> "$FM_HOME/state/inbox-calls.log"\n',
  );
  chmodSync(join(root, "bin", "fm-inbox.sh"), 0o755);
  put(join(root, "bin", "fm-update.sh"));
  put(join(root, ".agents", "skills", "stow", "SKILL.md"));
  put(join(root, ".agents", "skills", "updatefirstmate", "SKILL.md"));
  mkdirSync(join(root, "state"), { recursive: true });
  if (secondmate) put(join(root, ".fm-secondmate-home"));
  return root;
}
export function lane(root: string, id: string, status: string, meta = "kind=ship\n") {
  put(join(root, "state", `${id}.meta`), meta);
  put(join(root, "state", `${id}.status`), status);
}
export function toolUpdates(root: string, epochSeconds: number, reported: string) {
  put(
    join(root, "state", ".tool-updates"),
    `fm-tool-updates-v1\nepoch=${epochSeconds}\nreported=${reported}\n`,
  );
}
export function gitRepo(path: string, commits: number, date = "2026-10-01T12:00:00Z") {
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  git("init", "-q", "-b", "main");
  for (let i = 0; i < commits; i++) git("commit", "-q", "--allow-empty", "-m", `c${i}`);
}
export function stowResponse(finished: number, unsaved: number) {
  const answer = (probabilities: Record<string, number>) => {
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
    return { type: "choice", choice, probabilities, confidence: 0.9 };
  };
  return {
    model: "jev-test",
    usage: { input_tokens: 2000, output_tokens: 60 },
    answers: {
      done: answer({
        finished,
        not_finished: Number((1 - finished).toFixed(6)),
        unclear: 0,
      }),
      knowledge: answer({
        unsaved,
        saved_or_none: Number((1 - unsaved).toFixed(6)),
        unclear: 0,
      }),
    },
  };
}
