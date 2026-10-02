import { z } from "zod";
import { handle, requireMember } from "@/server/auth";
import { prodDeps } from "@/adapters/container";

export const runtime = "nodejs";

/** Base de conhecimento do cliente (camada Empresa cliente). */
export const POST = handle(async (req, ctx) => {
  const { tenantId } = await ctx.params;
  await requireMember(tenantId, ["dono", "admin", "operador"]);
  const b = z.object({ title: z.string().min(1), source: z.string().default("painel"), text: z.string().min(20) }).parse(await req.json());
  const id = await prodDeps().kb.ingest(tenantId, b.title, b.source, b.text);
  return Response.json({ documentId: id });
});
