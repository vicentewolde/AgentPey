/**
 * Keeps the Exponential board in step with the tickets, so nobody has to move
 * cards by hand (docs/planificacion-exponential/README.md).
 *
 * Exponential keeps two separate fields on an Action: `status` (ACTIVE /
 * COMPLETED / CANCELLED) and the board column, `kanbanStatus`. Completing an
 * action does not move its card, which is why finished work kept showing under
 * "To Do". This script closes that gap, in two rules:
 *
 * 1. An action whose status is COMPLETED goes to the DONE column.
 * 2. An action named "T<n> · ..." follows the ticket named "T<n> · ...":
 *    ticket IN_PROGRESS -> column IN_PROGRESS, QA -> IN_REVIEW,
 *    DONE -> status COMPLETED and column DONE. Any other ticket status leaves
 *    the action alone.
 *
 * It only ever writes `status` and `kanbanStatus`, never a title, date or
 * description, and it prints what it changed. `--dry-run` prints without
 * writing. It talks to Exponential through the `exponential` CLI the user is
 * already signed in with; it holds no credential of its own.
 *
 *   pnpm run exp:sync -- --dry-run
 */
import { execFileSync } from "node:child_process";

import { z } from "zod";

const WORKSPACE = "personal-cmud6knil0045l704wuoc5b1r";
const PRODUCT = "agentpey";
const PROJECT = "cmuebvdko001xl30497cuhc1z";

const ticketSchema = z.object({ id: z.string(), title: z.string(), status: z.string() });
const actionSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  kanbanStatus: z.string(),
});
type Action = z.infer<typeof actionSchema>;

const dryRun = process.argv.includes("--dry-run");

function exponential(args: string[]): string {
  return execFileSync("exponential", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function readJson<T>(schema: z.ZodType<T>, key: string, args: string[]): T[] {
  const raw = JSON.parse(exponential([...args, "--json"])) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)[key];
  return z.array(schema).parse(list);
}

/** The milestone number in a title like "T105 · ...", or undefined. */
function milestone(title: string): string | undefined {
  return /^(T\d+)\s*·/.exec(title)?.[1];
}

interface Change {
  action: Action;
  status?: "COMPLETED";
  kanban?: "IN_PROGRESS" | "IN_REVIEW" | "DONE";
  why: string;
}

function plan(actions: Action[], ticketStatusByMilestone: Map<string, string>): Change[] {
  const changes: Change[] = [];
  for (const action of actions) {
    const ticketStatus = ((): string | undefined => {
      const m = milestone(action.name);
      return m === undefined ? undefined : ticketStatusByMilestone.get(m);
    })();

    let status: Change["status"];
    let kanban: Change["kanban"];
    let why = "";
    if (ticketStatus === "DONE") {
      if (action.status !== "COMPLETED") status = "COMPLETED";
      if (action.kanbanStatus !== "DONE") kanban = "DONE";
      why = "its ticket is DONE";
    } else if (ticketStatus === "QA") {
      if (action.kanbanStatus !== "IN_REVIEW") kanban = "IN_REVIEW";
      why = "its ticket is in QA";
    } else if (ticketStatus === "IN_PROGRESS") {
      if (action.kanbanStatus !== "IN_PROGRESS") kanban = "IN_PROGRESS";
      why = "its ticket is in progress";
    }
    if (kanban === undefined && action.status === "COMPLETED" && action.kanbanStatus !== "DONE") {
      kanban = "DONE";
      why = "the action is completed";
    }
    if (status !== undefined || kanban !== undefined) {
      changes.push({ action, ...(status === undefined ? {} : { status }), ...(kanban === undefined ? {} : { kanban }), why });
    }
  }
  return changes;
}

const tickets = readJson(ticketSchema, "tickets", ["tickets", "list", "--workspace", WORKSPACE, "--product", PRODUCT]);

// `actions list` hides COMPLETED actions unless a column is asked for, so read
// every column and de-duplicate. Without this the "completed -> DONE" rule
// never sees the actions it exists for.
const COLUMNS = ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"];
const actionsById = new Map<string, Action>();
for (const column of COLUMNS) {
  for (const action of readJson(actionSchema, "actions", ["actions", "list", "--project", PROJECT, "--status", column])) {
    actionsById.set(action.id, action);
  }
}
const actions = [...actionsById.values()];

const ticketStatusByMilestone = new Map<string, string>();
for (const ticket of tickets) {
  const m = milestone(ticket.title);
  if (m !== undefined) ticketStatusByMilestone.set(m, ticket.status);
}

const changes = plan(actions, ticketStatusByMilestone);
if (changes.length === 0) {
  process.stdout.write("board already matches the tickets: nothing to change\n");
} else {
  for (const change of changes) {
    const flags = [
      ...(change.status === undefined ? [] : ["--status", change.status]),
      ...(change.kanban === undefined ? [] : ["--kanban", change.kanban]),
    ];
    process.stdout.write(`${dryRun ? "would set" : "set"} ${flags.join(" ")}  ${change.action.name}  (${change.why})\n`);
    if (!dryRun) exponential(["actions", "update", "--id", change.action.id, ...flags]);
  }
}
