import crypto from "node:crypto";
import { parseWebhook, verifySignature } from "@/adapters/whatsapp/cloud-api";
import { prodDeps } from "@/adapters/container";
import { newLead } from "@/core/lead";

export const runtime = "nodejs";

/** Verificação do webhook pela Meta. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

/**
 * Recebimento: valida assinatura, grava a mensagem na caixa de entrada durável
 * (RNF-03) e responde rápido. O worker processa depois da espera de mensagens picadas.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET ?? "")) {
    return new Response("assinatura inválida", { status: 401 });
  }
  const { repo } = prodDeps();
  for (const item of parseWebhook(JSON.parse(raw))) {
    const tenantId = await repo.tenantByPhoneNumberId(item.phoneNumberId);
    if (!tenantId) continue;
    const at = new Date(item.message.at);
    const lead = await repo.findOrCreateLead(tenantId, item.from, item.profileName, () =>
      newLead({ id: crypto.randomUUID(), tenantId, phone: item.from, now: at, source: "inbound", name: item.profileName }),
    );
    const m = item.message;
    await repo.insertInbound(tenantId, lead.id, {
      externalId: m.externalId,
      text: m.text ?? "",
      kind: m.kind,
      media: m.mediaId ? { mediaId: m.mediaId, mimeType: m.mimeType } : null,
      at: m.at,
    });
  }
  return new Response("ok", { status: 200 });
}
