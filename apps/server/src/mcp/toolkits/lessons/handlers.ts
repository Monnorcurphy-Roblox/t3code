import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { appendLesson } from "@t3tools/provider-core/server/execMemory";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Project from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { LessonsToolkit } from "./tools.ts";

const handlers = {
  // Writes only a local memory file, not repository or thread state, but tags
  // the lesson with the calling thread, so it needs that thread's live run.
  record_lesson: McpToolAccess.actsAsCaller(({ lesson }) =>
    Effect.gen(function* () {
      const { caller } = yield* loadCaller();
      if (caller === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "thread_credential_required",
          message: "record_lesson needs an agent running inside a T3 thread.",
        });
      const cwd =
        caller.worktreePath ??
        (yield* Effect.gen(function* () {
          const projects = yield* Project.ProjectService;
          const project = yield* projects
            .getById(caller.projectId)
            .pipe(Effect.mapError(unavailable));
          return Option.match(project, {
            onNone: () => "",
            onSome: ({ workspaceRoot }) => workspaceRoot,
          });
        }));
      const written = yield* Effect.try({
        try: () => appendLesson({ lesson, title: caller.title, cwd }),
        catch: () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The lesson could not be written to the lessons file.",
          }),
      });
      return written === undefined
        ? {
            recorded: false as const,
            reason: "Lesson memory is turned off on this server (T3_EXEC_MEMORY=0).",
          }
        : { recorded: true as const, file: written.file, line: written.line };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof LessonsToolkit.tools>;

export const layer = McpToolAccess.toLayer(LessonsToolkit, handlers);
