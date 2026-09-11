import { NextResponse } from "next/server";
import { protectedCron } from "@/lib/cron";
import { drainOutbox } from "@/lib/qstash";

export const maxDuration = 60;

/**
 * Publishes committed outbox rows to the broker. This is what makes the outbox
 * durable rather than decorative: a broker outage delays events, never loses
 * them, because publishing is retried from committed state.
 */
export const POST = protectedCron(async () => {
  const result = await drainOutbox(100);
  return NextResponse.json(result);
});
