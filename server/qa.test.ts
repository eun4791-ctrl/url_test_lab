import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("qa.getLatestRun", () => {
  it("should fetch latest run from GitHub", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    try {
      const result = await caller.qa.getLatestRun();
      // 결과가 id 필드를 가져야 함
      expect(result).toHaveProperty("id");
      console.log("✅ GitHub token is valid - Latest run ID:", result.id);
    } catch (error) {
      if ((error as Error).message.includes("GitHub token not configured")) {
        throw new Error("GITHUB_TOKEN environment variable is not set");
      }
      // GitHub API 호출 실패는 토큰이 없거나 잘못된 경우
      throw error;
    }
  });
});
