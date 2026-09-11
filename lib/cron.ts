import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

/**
 * Cron endpoints mutate every tenant's data, so they must never be openly
 * callable. Two accepted callers:
 *   - QStash schedules, proven by request signature (production)
 *   - a caller presenting CRON_SECRET (local, or a platform scheduler)
 * With neither configured the route refuses rather than defaulting to open.
 */
export function protectedCron(handler: (req: Request) => Promise<Response>) {
  if (process.env.QSTASH_CURRENT_SIGNING_KEY) {
    return verifySignatureAppRouter(handler);
  }

  return async (req: Request) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return NextResponse.json(
        { error: "Cron auth not configured: set QSTASH_CURRENT_SIGNING_KEY or CRON_SECRET" },
        { status: 503 },
      );
    }
    if (req.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handler(req);
  };
}
