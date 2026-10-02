import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MessengerPort, OutboundResult, WhatsAppTemplate } from "@/core/ports";
import type { InboundMessage } from "@/core/types";

const GRAPH = () => `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0"}`;

/** Credenciais por empresa: número próprio e token guardado no Vault (RNF-06). */
export async function numberCredentials(db: SupabaseClient, tenantId: string) {
  const { data: num, error } = await db.from("whatsapp_numbers").select("phone_number_id, waba_id").eq("tenant_id", tenantId).single();
  if (error) throw new Error(`número WhatsApp não configurado: ${error.message}`);
  const { data: token, error: e2 } = await db.rpc("whatsapp_token", { p_tenant: tenantId });
  if (e2 || !token) throw new Error("token do WhatsApp não encontrado no Vault");
  return { phoneNumberId: num.phone_number_id as string, wabaId: num.waba_id as string, token: token as string };
}

async function graph(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${GRAPH()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: body as Record<string, unknown> };
}

/** RF-33 — API oficial (Cloud API da Meta). */
export class CloudApiMessenger implements MessengerPort {
  constructor(private db: SupabaseClient) {}

  async sendText(tenantId: string, to: string, text: string): Promise<OutboundResult> {
    const c = await numberCredentials(this.db, tenantId);
    const r = await graph(`/${c.phoneNumberId}/messages`, c.token, {
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text, preview_url: true } }),
    });
    return toResult(r);
  }

  async sendTemplate(tenantId: string, to: string, t: WhatsAppTemplate, params: string[]): Promise<OutboundResult> {
    const c = await numberCredentials(this.db, tenantId);
    const r = await graph(`/${c.phoneNumberId}/messages`, c.token, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: t.name,
          language: { code: t.language },
          components: params.length ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p || "-" })) }] : [],
        },
      }),
    });
    return toResult(r);
  }
}

function toResult(r: { ok: boolean; body: Record<string, unknown> }): OutboundResult {
  if (!r.ok) return { ok: false, error: JSON.stringify(r.body.error ?? r.body) };
  const id = (r.body.messages as { id: string }[] | undefined)?.[0]?.id;
  return { ok: true, externalId: id };
}

/** Valida a assinatura X-Hub-Signature-256 do webhook. */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export interface ParsedWebhook {
  phoneNumberId: string;
  from: string;
  profileName?: string;
  message: InboundMessage;
}

/** Extrai mensagens recebidas do payload do webhook (ignora status de entrega). */
export function parseWebhook(payload: unknown): ParsedWebhook[] {
  const out: ParsedWebhook[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: { value?: Record<string, unknown> }[] }[]) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const phoneNumberId = (v.metadata as { phone_number_id?: string })?.phone_number_id;
      const contacts = (v.contacts as { wa_id: string; profile?: { name?: string } }[]) ?? [];
      for (const m of (v.messages as Record<string, unknown>[]) ?? []) {
        if (!phoneNumberId) continue;
        const from = m.from as string;
        const type = m.type as string;
        const at = new Date(Number(m.timestamp) * 1000).toISOString();
        const base = { externalId: m.id as string, at };
        let message: InboundMessage;
        if (type === "text") message = { ...base, kind: "text", text: (m.text as { body: string }).body };
        else if (type === "audio") message = { ...base, kind: "audio", mediaId: (m.audio as { id: string }).id, mimeType: (m.audio as { mime_type: string }).mime_type };
        else if (type === "image") {
          const img = m.image as { id: string; mime_type: string; caption?: string };
          message = { ...base, kind: "image", mediaId: img.id, mimeType: img.mime_type, text: img.caption };
        } else if (type === "document") {
          const doc = m.document as { id: string; mime_type: string; caption?: string };
          message = { ...base, kind: "document", mediaId: doc.id, mimeType: doc.mime_type, text: doc.caption };
        } else if (type === "button") message = { ...base, kind: "text", text: (m.button as { text: string }).text };
        else if (type === "interactive") {
          const i = m.interactive as { button_reply?: { title: string }; list_reply?: { title: string } };
          message = { ...base, kind: "text", text: i.button_reply?.title ?? i.list_reply?.title ?? "" };
        } else message = { ...base, kind: "other", text: `[mensagem do tipo ${type}]` };
        out.push({ phoneNumberId, from, profileName: contacts.find((c) => c.wa_id === from)?.profile?.name, message });
      }
    }
  }
  return out;
}

/** Baixa mídia recebida (áudio, imagem, PDF). */
export async function downloadMedia(token: string, mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
  const meta = await graph(`/${mediaId}`, token);
  if (!meta.ok) throw new Error(`mídia ${mediaId}: ${JSON.stringify(meta.body)}`);
  const res = await fetch(meta.body.url as string, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`download de mídia: ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), mimeType: meta.body.mime_type as string };
}

/** RF-38 — lê qualidade e limite de envio do número na Meta. */
export async function fetchNumberHealth(token: string, phoneNumberId: string) {
  const r = await graph(`/${phoneNumberId}?fields=quality_rating,messaging_limit_tier,status`, token);
  if (!r.ok) throw new Error(JSON.stringify(r.body));
  return {
    quality: (r.body.quality_rating as string) ?? "UNKNOWN",
    messagingLimit: (r.body.messaging_limit_tier as string) ?? "UNKNOWN",
  };
}

/** Status de aprovação dos modelos (gerenciador de modelos, RF-33). */
export async function fetchTemplateStatuses(token: string, wabaId: string) {
  const r = await graph(`/${wabaId}/message_templates?fields=name,language,status,category&limit=200`, token);
  if (!r.ok) throw new Error(JSON.stringify(r.body));
  return (r.body.data as { name: string; language: string; status: string; category: string }[]) ?? [];
}

/** Envia um modelo para aprovação da Meta. */
export async function submitTemplate(token: string, wabaId: string, t: { name: string; language: string; category: string; body: string; examples: string[] }) {
  return graph(`/${wabaId}/message_templates`, token, {
    method: "POST",
    body: JSON.stringify({
      name: t.name,
      language: t.language,
      category: t.category,
      components: [{ type: "BODY", text: t.body, ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}) }],
    }),
  });
}
