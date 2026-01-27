import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: any;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  // Mock user for local development to bypass authentication
  const user = { openId: "dev-user", role: "admin", name: "Developer" };

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
