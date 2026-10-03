import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  authUsers,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MENTION_TEST_ADAPTER = "mention_comment_suppression_test";

describeEmbeddedPostgres("heartbeat mention comment suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-mention-comment-suppression-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: MENTION_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: { summary: "Message final du run, prêt à être publié." },
      }),
      testEnvironment: async () => ({
        adapterType: MENTION_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    unregisterServerAdapter(MENTION_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function insertFixture() {
    const companyId = randomUUID();
    const mentionedAgentId = randomUUID();
    const ownerAgentId = randomUUID();
    const foreignIssueId = randomUUID();
    const ownIssueId = randomUUID();

    const now = new Date();
    await db.insert(authUsers).values({ id: "operator", name: "Operator", email: "operator@example.test", createdAt: now, updatedAt: now });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    for (const [id, name] of [
      [mentionedAgentId, "Mentioned Agent"],
      [ownerAgentId, "Owner Agent"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: MENTION_TEST_ADAPTER,
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
        permissions: {},
      });
    }
    await db.insert(issues).values([
      {
        id: foreignIssueId,
        companyId,
        title: "Ticket of another agent",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: ownerAgentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: ownIssueId,
        companyId,
        title: "Ticket of the mentioned agent",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: mentionedAgentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    return { companyId, mentionedAgentId, foreignIssueId, ownIssueId };
  }

  async function waitForTerminalRun(runId: string, agentId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [state] = await db.select({ lastRunId: agentRuntimeState.lastRunId }).from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
      if (run && run.status !== "queued" && run.status !== "running" && state?.lastRunId === runId) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for run ${runId}`);
  }

  // Le commentaire du message final est écrit après l'événement « run succeeded » :
  // la décision de présentation est le seul signal que cette étape est terminée.
  async function waitForPresentation(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const events = await db.select({ message: heartbeatRunEvents.message }).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      if (events.some((event) => event.message === "run presentation resolved")) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for presentation of run ${runId}`);
  }

  async function runMentionWake(companyId: string, agentId: string, issueId: string) {
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const [mention] = await db
      .insert(issueComments)
      .values({ companyId, issueId, authorUserId: "operator", body: "@Mentioned Agent un avis ?" })
      .returning({ id: issueComments.id });
    const commentId = mention!.id;
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId },
      contextSnapshot: { issueId, taskId: issueId, commentId, wakeCommentId: commentId, wakeReason: "issue_comment_mentioned" },
      requestedByActorType: "user",
      requestedByActorId: "operator",
    });
    expect(run).not.toBeNull();
    await waitForTerminalRun(run!.id, agentId);
    await heartbeat.waitForRunExecutionDrain(run!.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await waitForPresentation(run!.id);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    return comments.filter((comment) => comment.authorAgentId !== null);
  }

  it("does not publish the final message when mentioned on a ticket assigned to another agent", async () => {
    // Cas vécu : l'Intendante, mentionnée sur PER-32 (ticket de l'Architecte),
    // y publiait le message final de chaque run — 9 commentaires en 2 h, alors
    // qu'une mention appelle une réponse ciblée, pas le compte rendu du run.
    const { companyId, mentionedAgentId, foreignIssueId } = await insertFixture();
    const comments = await runMentionWake(companyId, mentionedAgentId, foreignIssueId);
    expect(comments).toHaveLength(0);
  }, 20_000);

  it("still publishes the final message when the mention lands on the agent's own ticket", async () => {
    const { companyId, mentionedAgentId, ownIssueId } = await insertFixture();
    const comments = await runMentionWake(companyId, mentionedAgentId, ownIssueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorAgentId).toBe(mentionedAgentId);
  }, 20_000);
});
