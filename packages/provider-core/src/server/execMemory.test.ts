// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { appendLesson, buildExecMemoryInstructions, selectLessons } from "./execMemory.ts";

const LESSONS = [
  "# Lessons from Exec workers",
  "",
  "- 2026-10-01 [Old general · /home/me] General lesson one.",
  "- 2026-10-02 [Creator hub bug · /home/me/creator-hub] Creator hub lesson.",
  "- 2026-10-03 [Connor's preference] Keep answers short.",
  "- 2026-10-04 [Game jam · /home/me/game-jam] Game jam lesson.",
  "- 2026-10-05 [Recent general · /home/me] General lesson two.",
].join("\n");

describe("selectLessons", () => {
  it("ranks preferences, then this project's lessons, then the newest others", () => {
    expect(
      selectLessons(LESSONS, { cwd: "/home/me/creator-hub/apps/web", homeDir: "/home/me" }),
    ).toEqual([
      "- 2026-10-03 [Connor's preference] Keep answers short.",
      "- 2026-10-02 [Creator hub bug · /home/me/creator-hub] Creator hub lesson.",
      "- 2026-10-05 [Recent general · /home/me] General lesson two.",
      "- 2026-10-04 [Game jam · /home/me/game-jam] Game jam lesson.",
      "- 2026-10-01 [Old general · /home/me] General lesson one.",
    ]);
  });

  it("does not treat a sibling path prefix as the same project", () => {
    const text =
      "- 2026-10-02 [Hub · /home/me/creator-hub] Hub lesson.\n- 2026-10-03 [X · /home/me] Newer.";
    expect(
      selectLessons(text, { cwd: "/home/me/creator-hub-thumbnails", homeDir: "/home/me" })[0],
    ).toContain("Newer.");
  });

  it("stays within the character budget", () => {
    const selected = selectLessons(LESSONS, { homeDir: "/home/me", maxChars: 120 });
    expect(selected.join("\n").length).toBeLessThanOrEqual(120);
    expect(selected[0]).toContain("Keep answers short.");
  });
});

describe("exec memory files", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = FS.mkdtempSync(Path.join(OS.tmpdir(), "exec-memory-"));
    env = { T3_EXEC_HOME: home };
  });
  afterEach(() => FS.rmSync(home, { recursive: true, force: true }));

  it("adds nothing when no memory exists or memory is disabled", () => {
    expect(buildExecMemoryInstructions({}, env)).toBe("");
    FS.writeFileSync(Path.join(home, "t3-lessons.md"), "Be brief.");
    expect(buildExecMemoryInstructions({}, { ...env, T3_EXEC_MEMORY: "0" })).toBe("");
  });

  it("includes preferences, lessons and the record_lesson prompt", () => {
    FS.writeFileSync(Path.join(home, "t3-lessons.md"), "# Preferences\n\nBe brief.\n");
    FS.mkdirSync(Path.join(home, "work"));
    FS.writeFileSync(Path.join(home, "work", "lessons.md"), LESSONS);
    const instructions = buildExecMemoryInstructions({ cwd: "/home/me/game-jam" }, env);
    expect(instructions).toMatch(/^<exec_memory>/);
    expect(instructions).toContain("<preferences>\n# Preferences\n\nBe brief.\n</preferences>");
    expect(instructions).toContain("Game jam lesson.");
    expect(instructions).toContain("call the t3-code record_lesson tool");
    expect(instructions).toContain("not permission");
  });

  it("points at the file when the lesson tool is unavailable", () => {
    FS.writeFileSync(Path.join(home, "t3-lessons.md"), "Be brief.");
    expect(buildExecMemoryInstructions({ lessonToolAvailable: false }, env)).toContain(
      Path.join(home, "work", "lessons.md"),
    );
  });

  it("appends in the Exec team format and the next prompt reads it", () => {
    const now = new Date(2026, 9, 14);
    const first = appendLesson(
      { lesson: "  Use fnm\nfor Node 24. ", title: "T3 fork [exec]", cwd: "/home/me/t3code", now },
      env,
    );
    expect(first?.line).toBe(
      "- 2026-10-14 [T3 fork (exec) · /home/me/t3code] Use fnm for Node 24.",
    );
    appendLesson({ lesson: "Second.", title: "T3 fork", cwd: "/home/me/t3code", now }, env);
    const text = FS.readFileSync(Path.join(home, "work", "lessons.md"), "utf8");
    expect(text.startsWith("# Lessons from Exec workers\n\n")).toBe(true);
    expect(text.match(/^# Lessons/gm)).toHaveLength(1);
    expect(buildExecMemoryInstructions({ cwd: "/home/me/t3code" }, env)).toContain("Second.");
  });
});
