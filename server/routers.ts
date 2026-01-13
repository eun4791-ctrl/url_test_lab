import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { z } from "zod";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  qa: router({
    triggerWorkflow: publicProcedure
      .input(z.object({
        targetUrl: z.string().url(),
        tests: z.string(),
      }))
      .mutation(async ({ input }) => {
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        const GITHUB_REPO = "eun4791-ctrl/ai_web_test";

        if (!GITHUB_TOKEN) {
          throw new Error("GitHub token not configured");
        }

        try {
          const response = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/qa-tests.yml/dispatches`,
            {
              method: "POST",
              headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                "Content-Type": "application/json",
                Accept: "application/vnd.github.v3+json",
              },
              body: JSON.stringify({
                ref: "main",
                inputs: {
                  target_url: input.targetUrl,
                  tests: input.tests,
                },
              }),
            }
          );

          if (!response.ok) {
            const error = await response.text();
            console.error("Workflow trigger failed:", response.status, error);
            throw new Error(`Failed to trigger workflow: ${response.status}`);
          }

          return { success: true };
        } catch (error) {
          console.error("Trigger error:", error);
          throw error;
        }
      }),

    getLatestRun: publicProcedure.query(async () => {
      const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
      const GITHUB_REPO = "eun4791-ctrl/ai_web_test";

      if (!GITHUB_TOKEN) {
        throw new Error("GitHub token not configured");
      }

      try {
        const response = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=1`,
          {
            headers: {
              Authorization: `token ${GITHUB_TOKEN}`,
              Accept: "application/vnd.github.v3+json",
            },
          }
        );

        if (!response.ok) throw new Error("Failed to fetch runs");

        const data = await response.json();
        const latestRun = data.workflow_runs?.[0];
        return { id: latestRun?.id || null };
      } catch (error) {
        console.error("Error fetching run ID:", error);
        throw error;
      }
    }),

    checkRunStatus: publicProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ input }) => {
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        const GITHUB_REPO = "eun4791-ctrl/ai_web_test";

        if (!GITHUB_TOKEN) {
          throw new Error("GitHub token not configured");
        }

        try {
          const response = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/actions/runs/${input.runId}`,
            {
              headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: "application/vnd.github.v3+json",
              },
            }
          );

          if (!response.ok) throw new Error("Failed to fetch run status");

          const data = await response.json();
          return { status: data.status, conclusion: data.conclusion };
        } catch (error) {
          console.error("Error checking status:", error);
          throw error;
        }
      }),

    getArtifacts: publicProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ input }) => {
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        const GITHUB_REPO = "eun4791-ctrl/ai_web_test";

        if (!GITHUB_TOKEN) {
          throw new Error("GitHub token not configured");
        }

        try {
          const response = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/actions/runs/${input.runId}/artifacts`,
            {
              headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: "application/vnd.github.v3+json",
              },
            }
          );

          if (!response.ok) throw new Error("Failed to fetch artifacts");

          const data = await response.json();
          return { artifacts: data.artifacts || [] };
        } catch (error) {
          console.error("Error fetching artifacts:", error);
          throw error;
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
