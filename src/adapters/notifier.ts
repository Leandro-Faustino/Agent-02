import crypto from "node:crypto";
import type { NotifierPort, Repository, HandoffMode } from "@/core/ports";
import type { TenantConfig } from "@/core/types";

/**
 * Avisos ao vendedor e ao cliente: registra no CRM da plataforma (painel) e,
 * se configurado, envia por webhook assinado para o CRM/ferramenta do cliente.
 */
export class WebhookNotifier implements NotifierPort {
  constructor(private repo: Repository) {}

  private async post(config: TenantConfig | null, body: Record<string, unknown>) {
    const url = config?.integrations.webhookUrl;
    if (!url) return;
    const raw = JSON.stringify(body);
    const sig = config.integrations.webhookSecret
      ? crypto.createHmac("sha256", config.integrations.webhookSecret).update(raw).digest("hex")
      : undefined;
    try {
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(sig ? { "X-SDR-Signature": sig } : {}) }, body: raw });
    } catch (e) {
      console.error("webhook do cliente falhou", e);
    }
  }

  async notifySeller(config: TenantConfig, sellerId: string, p: { leadId: string; summary: string; mode: HandoffMode }) {
    await this.repo.logEvent(config.tenantId, p.leadId, "aviso_vendedor", { sellerId, mode: p.mode, summary: p.summary });
    await this.post(config, { type: "passagem_bastao", sellerId, ...p });
  }

  async notifyTenant(tenantId: string, kind: string, payload: Record<string, unknown>) {
    await this.repo.logEvent(tenantId, String(payload.leadId ?? ""), `alerta_${kind}`, payload);
    await this.post(await this.repo.getConfig(tenantId), { type: kind, ...payload });
  }
}
