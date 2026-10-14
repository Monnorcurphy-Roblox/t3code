import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Project,
  type ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as LessonsHandlers from "./handlers.ts";
import { LessonsToolkit } from "./tools.ts";

const ENV_KEYS = ["T3_EXEC_MEMORY", "T3_EXEC_HOME", "T3_EXEC_LESSONS_FILE"] as const;

/**
 * Points Exec memory at a fresh temp dir for the test's scope, so the real
 * ~/.cursor/exec files are never touched, and restores the environment after.
 * The root test config disables Exec memory; `enabled` turns it back on.
 */
const execHome = (enabled: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-record-lesson-" });
    const lessonsFile = path.join(home, "work", "lessons.md");
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
        process.env.T3_EXEC_MEMORY = enabled ? "1" : "0";
        process.env.T3_EXEC_HOME = home;
        process.env.T3_EXEC_LESSONS_FILE = lessonsFile;
        return saved;
      }),
      (saved) =>
        Effect.sync(() => {
          for (const key of ENV_KEYS) {
            const value = saved[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
    return { fs, lessonsFile };
  });

const threadId = ThreadId.make("record-lesson-thread");
const workspaceRoot = "/workspace/record-lesson-project";

const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("record-lesson-environment"),
  requestNamespace: "record-lesson-provider-session",
  thread: {
    threadId,
    providerSessionId: "record-lesson-provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
};

const project = (id: ProjectId): Project => ({
  id,
  title: "Record lesson project",
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const recordLesson = (
  lesson: string,
  options: {
    readonly scope?: McpInvocationContext.McpInvocationScope;
    readonly worktreePath?: string | null;
    readonly activeRun?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, options.scope ?? threadScope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed({
            ...McpToolAccessTestkit.liveThreadShell(
              id,
              options.activeRun === false ? { activeRunId: null } : {},
            ),
            title: "Fix MCP lessons",
            worktreePath: options.worktreePath ?? null,
          }),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (projectId) => Effect.succeedSome(project(projectId)),
      }),
    );
    const toolkit = yield* LessonsToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(LessonsHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const results = yield* toolkit
      .handle("record_lesson", { lesson })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    return results.at(-1)?.result;
  });

it.effect("appends the lesson tagged with the thread title and its worktree", () =>
  Effect.gen(function* () {
    const { fs, lessonsFile } = yield* execHome(true);
    const worktreePath = "/workspace/record-lesson-project/.worktrees/lessons";
    const result = yield* recordLesson("  Run tsc-rs directly;\n pnpm reinstalls.  ", {
      worktreePath,
    });
    expect(result).toEqual({
      recorded: true,
      file: lessonsFile,
      line: expect.stringMatching(
        /^- \d{4}-\d{2}-\d{2} \[Fix MCP lessons · \/workspace\/record-lesson-project\/\.worktrees\/lessons\] Run tsc-rs directly; pnpm reinstalls\.$/,
      ),
    });
    const text = yield* fs.readFileString(lessonsFile);
    expect(text.startsWith("# Lessons from Exec workers")).toBe(true);
    expect(text.trimEnd().split("\n").at(-1)).toBe((result as { readonly line: string }).line);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("falls back to the project's workspace root without a worktree", () =>
  Effect.gen(function* () {
    yield* execHome(true);
    const result = yield* recordLesson("Check file-count capacity before large installs.");
    expect(result).toMatchObject({
      recorded: true,
      line: expect.stringContaining(`[Fix MCP lessons · ${workspaceRoot}] Check file-count`),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a disabled memory instead of writing", () =>
  Effect.gen(function* () {
    const { fs, lessonsFile } = yield* execHome(false);
    const result = yield* recordLesson("Never written.");
    expect(result).toEqual({ recorded: false, reason: expect.stringContaining("T3_EXEC_MEMORY") });
    expect(yield* fs.exists(lessonsFile)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a caller outside a T3 thread", () =>
  Effect.gen(function* () {
    const { fs, lessonsFile } = yield* execHome(true);
    const result = yield* recordLesson("Never written.", {
      scope: {
        ...threadScope,
        thread: undefined,
        client: { sessionId: "outside-client", label: "Outside", access: "full-access" },
      },
    });
    expect(result).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "thread_credential_required",
    });
    expect(yield* fs.exists(lessonsFile)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a thread whose run has ended", () =>
  Effect.gen(function* () {
    const { fs, lessonsFile } = yield* execHome(true);
    const result = yield* recordLesson("Never written.", { activeRun: false });
    expect(result).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "parent_not_active",
    });
    expect(yield* fs.exists(lessonsFile)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
