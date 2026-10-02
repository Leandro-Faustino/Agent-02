import { handle, requireCron } from "@/server/auth";
import { processInbound } from "@/server/workers";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = handle(async (req) => {
  requireCron(req);
  return Response.json({ results: await processInbound() });
});
