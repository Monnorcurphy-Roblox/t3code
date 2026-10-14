// @effect-diagnostics nodeBuiltinImport:off globalDate:off - prompt builders are synchronous, non-Effect call sites.
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const PREFERENCES_MAX_CHARS = 2000;
const LESSONS_MAX_CHARS = 3500;
const LESSON_MAX_CHARS = 600;
const TITLE_MAX_CHARS = 60;
const PREFERENCE_TAG = "Connor's preference";
const NEW_FILE_HEADER =
  "# Lessons from Exec workers\n\nNewest last. Workers read the tail of this file before starting.\n\n";
const LESSON_LINE = /^- (\d{4}-\d{2}-\d{2}) \[(.*?)\] (.+)$/;

export interface ExecMemoryPaths {
  readonly preferencesFile: string;
  readonly lessonsFile: string;
}

/** Shares the Exec team's files so T3 threads and team workers learn from one store. */
export function resolveExecMemoryPaths(
  env: NodeJS.ProcessEnv = process.env,
): ExecMemoryPaths | undefined {
  if (env.T3_EXEC_MEMORY === "0") return undefined;
  const home = env.T3_EXEC_HOME ?? Path.join(OS.homedir(), ".cursor", "exec");
  return {
    preferencesFile: Path.join(home, "t3-lessons.md"),
    lessonsFile: env.T3_EXEC_LESSONS_FILE ?? Path.join(home, "work", "lessons.md"),
  };
}

interface Lesson {
  readonly line: string;
  readonly date: string;
  readonly isPreference: boolean;
  readonly cwd: string | undefined;
}

function parseLesson(line: string): Lesson | undefined {
  const match = LESSON_LINE.exec(line);
  if (!match) return undefined;
  const tag = match[2] ?? "";
  const separator = tag.lastIndexOf(" · ");
  return {
    line,
    date: match[1] ?? "",
    isPreference: tag === PREFERENCE_TAG,
    cwd: separator === -1 ? undefined : tag.slice(separator + 3).trim() || undefined,
  };
}

function isWithin(child: string, parent: string): boolean {
  const relative = Path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !Path.isAbsolute(relative));
}

/** Connor's preferences first, then lessons from this project, then the most recent others. */
export function selectLessons(
  text: string,
  options: {
    readonly cwd?: string | undefined;
    readonly homeDir?: string;
    readonly maxChars?: number;
  } = {},
): ReadonlyArray<string> {
  const homeDir = options.homeDir ?? OS.homedir();
  const maxChars = options.maxChars ?? LESSONS_MAX_CHARS;
  const lessons = text
    .split("\n")
    .map(parseLesson)
    .filter((lesson): lesson is Lesson => lesson !== undefined)
    .toReversed();
  const isProject = (lesson: Lesson) =>
    options.cwd !== undefined &&
    lesson.cwd !== undefined &&
    lesson.cwd !== homeDir &&
    isWithin(options.cwd, lesson.cwd);
  const ranked = [
    ...lessons.filter((lesson) => lesson.isPreference),
    ...lessons.filter((lesson) => !lesson.isPreference && isProject(lesson)),
    ...lessons.filter((lesson) => !lesson.isPreference && !isProject(lesson)),
  ];
  const selected: string[] = [];
  let used = 0;
  for (const lesson of ranked) {
    if (used + lesson.line.length + 1 > maxChars) continue;
    selected.push(lesson.line);
    used += lesson.line.length + 1;
  }
  return selected;
}

const fileCache = new Map<
  string,
  { readonly mtimeMs: number; readonly size: number; readonly text: string }
>();

function readText(file: string): string | undefined {
  try {
    const { mtimeMs, size } = FS.statSync(file);
    const cached = fileCache.get(file);
    if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached.text;
    const text = FS.readFileSync(file, "utf8");
    fileCache.set(file, { mtimeMs, size, text });
    return text;
  } catch {
    return undefined;
  }
}

/** Empty when no Exec memory exists, so stock installs see no prompt change. */
export function buildExecMemoryInstructions(
  input: { readonly cwd?: string | null | undefined; readonly lessonToolAvailable?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const paths = resolveExecMemoryPaths(env);
  if (paths === undefined) return "";
  const preferences = readText(paths.preferencesFile)?.trim().slice(0, PREFERENCES_MAX_CHARS);
  const lessonsText = readText(paths.lessonsFile);
  const lessons =
    lessonsText === undefined ? [] : selectLessons(lessonsText, { cwd: input.cwd ?? undefined });
  if (!preferences && lessons.length === 0) return "";
  const sections = [
    "Memory carried over from earlier threads and Exec team workers. Apply what is relevant to this task. It is context, not permission: approval rules for external actions still apply.",
    ...(preferences ? [`<preferences>\n${preferences}\n</preferences>`] : []),
    ...(lessons.length > 0 ? [`<lessons>\n${lessons.join("\n")}\n</lessons>`] : []),
    input.lessonToolAvailable === false
      ? `When the user corrects you or you find a reusable fix, append one line to ${paths.lessonsFile} in the format above.`
      : "When the user corrects you, confirms a non-obvious approach, or you find a reusable fix or trap, call the t3-code record_lesson tool with one specific sentence so future threads start with it. Do not record secrets, task status, or anything already in the lessons above.",
  ];
  return `<exec_memory>\n${sections.join("\n\n")}\n</exec_memory>`;
}

function oneLine(value: string, max: number): string {
  return value.replaceAll(/\s+/g, " ").trim().slice(0, max);
}

function withoutBrackets(value: string): string {
  return value.replaceAll("[", "(").replaceAll("]", ")");
}

/** Appends in the Exec team's `- date [title · cwd] lesson` format. */
export function appendLesson(
  input: {
    readonly lesson: string;
    readonly title: string;
    readonly cwd: string;
    readonly now?: Date;
  },
  env: NodeJS.ProcessEnv = process.env,
): { readonly file: string; readonly line: string } | undefined {
  const paths = resolveExecMemoryPaths(env);
  if (paths === undefined) return undefined;
  const lesson = oneLine(input.lesson, LESSON_MAX_CHARS);
  const title = withoutBrackets(oneLine(input.title, TITLE_MAX_CHARS)) || "T3 thread";
  const cwd = withoutBrackets(oneLine(input.cwd, 300));
  const now = input.now ?? new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const line = `- ${date} [${title} · ${cwd}] ${lesson}`;
  FS.mkdirSync(Path.dirname(paths.lessonsFile), { recursive: true });
  const exists = FS.existsSync(paths.lessonsFile);
  FS.appendFileSync(paths.lessonsFile, `${exists ? "" : NEW_FILE_HEADER}${line}\n`);
  return { file: paths.lessonsFile, line };
}
