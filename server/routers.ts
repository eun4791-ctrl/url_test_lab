import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { ENV } from "./_core/env";

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
        const testsList = input.tests.split(",").filter(t => t.trim().length > 0);

        try {
          const { startTest } = await import("./testRunner");
          const runId = startTest(input.targetUrl, testsList);
          return { success: true, runId };
        } catch (error: any) {
          console.error("Local trigger error:", error);
          throw new Error(error.message || "Failed to start local test");
        }
      }),

    getLatestRun: publicProcedure.query(async () => {
      const { getTestState } = await import("./testRunner");
      const state = getTestState();
      return { id: state.runId };
    }),

    checkRunStatus: publicProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ input }) => {
        const { getTestState } = await import("./testRunner");
        const state = getTestState();

        // If runId doesn't match current state, assume it's lost/unknown or old
        if (state.runId !== input.runId) {
          return { status: "unknown", conclusion: null };
        }

        return {
          status: state.status,
          // Map local status to GitHub conclusion styles if needed
          conclusion: state.status === "completed" ? "success" : (state.status === "failed" ? "failure" : null)
        };
      }),

    getArtifacts: publicProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ input }) => {
        // Return a list of available "artifacts" (files) based on what we know exists locally
        // We pretend these are GitHub artifacts so the client logic holds up for now
        const artifacts = [];
        const fs = await import("fs");
        const path = await import("path");
        const projectRoot = path.resolve(process.cwd());

        if (fs.existsSync(path.join(projectRoot, "reports/performance.report.json"))) {
          artifacts.push({ name: "lighthouse-report" });
        }
        if (fs.existsSync(path.join(projectRoot, "screenshots"))) {
          artifacts.push({ name: "responsive-screenshots" });
        }
        if (fs.existsSync(path.join(projectRoot, "reports/tc-report.json"))) {
          artifacts.push({ name: "test-cases-report" });
        }
        if (fs.existsSync(path.join(projectRoot, "videos/test-video.webm"))) {
          artifacts.push({ name: "test-video" });
        }
        if (fs.existsSync(path.join(projectRoot, "reports/ux-review.json"))) {
          artifacts.push({ name: "ux-review" });
        }

        return { artifacts };
      }),

    downloadArtifact: publicProcedure
      .input(z.object({
        runId: z.number(),
        artifactName: z.string(),
      }))
      .mutation(async ({ input }) => {
        const fs = await import("fs");
        const path = await import("path");
        const projectRoot = path.resolve(process.cwd());

        // We return raw content or data URLs directly, skipping the ZIP download part.
        // The client expects base64 of a ZIP usually, so we might need to adjust client or fake it.
        // BUT, looking at client, it downloads ZIP then unzips.
        // To keep client changes minimal effectively, we might want to ZIP it on fly?
        // OR simpler: we just updated client plan to "Simplify client code". 
        // So here we will return RAW JSON or similar, and we will update Client to START consuming raw data.

        // Wait, the detailed plan said "3. Result file serving... downloadArtifact modification".
        // Let's assume we return the content directly in a property the client can use, 
        // OR we stick to the existing "success, data(base64)" contract but change the content format to plain JSON string or file buffer?
        // Actually, let's look at `parseArtifactJson` procedure. It takes base64.

        // Strategy: 
        // For JSON files: Read JSON, return as string (or base64 string).
        // For Screenshots: Read directory, return list of base64 images? 
        // Client `downloadArtifact` returns `data` (base64 of zip).

        // Let's implement a simplier path: just return the File content as base64.
        // Client will fail to "unzip" it if it's not a zip. 
        // So we MUST change Client too. I will assume we will change client in next step.

        try {
          if (input.artifactName === "lighthouse-report") {
            const p = path.join(projectRoot, "reports/lighthouse-report.json");
            if (fs.existsSync(p)) {
              const content = fs.readFileSync(p, "utf-8"); // JSON string
              return { success: true, data: Buffer.from(content).toString("base64"), type: "json" };
            }
          }
          // ... handle others
        } catch (e) { /* ignore */ }

        return { success: false, error: "Not implemented for local yet" };
      }),

    // New helper to get JSON data directly without zip
    getArtifactContent: publicProcedure
      .input(z.object({ artifactName: z.string() }))
      .query(async ({ input }) => {
        const fs = await import("fs");
        const path = await import("path");
        const projectRoot = path.resolve(process.cwd());

        if (input.artifactName === "lighthouse-report") {
          const p = path.join(projectRoot, "reports/performance.report.json");
          if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
        }
        if (input.artifactName === "tc-report") {
          const p = path.join(projectRoot, "reports/tc-report.json");
          if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
        }
        if (input.artifactName === "ux-review") {
          const p = path.join(projectRoot, "reports/ux-review.json");
          if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
        }
        return null;
      }),

    // Helper for screenshots
    getScreenshots: publicProcedure.query(async () => {
      const fs = await import("fs");
      const path = await import("path");
      const dir = path.join(process.cwd(), "screenshots");
      const result: Record<string, string> = {};

      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith(".png")) {
            const b64 = fs.readFileSync(path.join(dir, file)).toString("base64");
            const key = file.replace(".png", ""); // desktop, tablet, mobile
            result[key] = `data:image/png;base64,${b64}`;
          }
        }
      }
      return result;
    })
  }),
});

export type AppRouter = typeof appRouter;
