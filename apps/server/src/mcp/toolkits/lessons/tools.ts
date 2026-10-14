import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const RecordLessonTool = Tool.make("record_lesson", {
  description:
    "Needs an agent running inside a T3 thread. Save one reusable lesson so future threads and Exec team workers start with it. Call it when the user corrects you, confirms a non-obvious approach, or you find a reusable fix or trap. Pass one specific sentence; do not record secrets, task status, or a lesson already in your instructions. The lesson is tagged with this thread's title and workspace and appended to the local lessons file. Returns recorded:false with a reason when lesson memory is turned off.",
  parameters: Schema.Struct({
    lesson: TrimmedNonEmptyString.annotate({
      description:
        "One specific, reusable sentence, for example 'Run tsc-rs directly from apps/server; pnpm scripts reinstall dependencies.' Longer text is cut to 600 characters.",
    }),
  }),
  success: Schema.Union([
    Schema.Struct({
      recorded: Schema.Literal(true),
      file: Schema.String,
      line: Schema.String,
    }),
    Schema.Struct({
      recorded: Schema.Literal(false),
      reason: Schema.String,
    }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
  ],
})
  .annotate(Tool.Title, "Record a lesson")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const LessonsToolkit = Toolkit.make(RecordLessonTool);
