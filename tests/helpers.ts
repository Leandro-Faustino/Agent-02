import { memoryDeps } from "@/adapters/memory";
import { ScriptedLlm, type Script } from "@/adapters/llm/scripted";
import { DEMO_CONFIG, DEMO_TEMPLATES } from "@/fixtures/demo";
import { newLead } from "@/core/lead";
import type { ChatMessage, Lead, TenantConfig } from "@/core/types";
import { handleInbound } from "@/core/agent/engine";

/** Segunda-feira, 5/10/2026, 10h em São Paulo. */
export const MONDAY_10H = new Date("2026-10-05T13:00:00Z");

export function setup(script: Script, opts: { config?: Partial<TenantConfig>; lead?: Partial<Lead> } = {}) {
  const llm = new ScriptedLlm(script);
  const env = memoryDeps(llm, MONDAY_10H);
  const config = { ...structuredClone(DEMO_CONFIG), ...opts.config };
  env.repo.configs.set("demo", config);
  env.repo.templates.set("demo", DEMO_TEMPLATES);
  const lead = { ...newLead({ id: "L1", tenantId: "demo", phone: "5511988887777", now: MONDAY_10H, name: "Carla Souza" }),
    // Conversa em andamento: a apresentação já aconteceu (RF-34.1).
    lastOutboundAt: new Date(MONDAY_10H.getTime() - 3600000).toISOString(),
    ...opts.lead,
  };
  env.repo.leads.set(lead.id, lead);
  let n = 0;
  const say = async (...texts: string[]) => {
    const msgs: ChatMessage[] = texts.map((t) => ({ id: `in${++n}`, leadId: "L1", role: "lead", text: t, at: env.clock.now().toISOString() }));
    for (const m of msgs) await env.repo.appendMessage(m);
    return handleInbound(env.deps, "L1", msgs);
  };
  const lead$ = () => env.repo.leads.get("L1")!;
  return { ...env, llm, config, say, lead: lead$ };
}

export const QUALIFIED = {
  encaixe_pic: { value: "clínica odontológica com 20 funcionários", satisfied: true },
  dor: { value: "fechamento atrasa até o dia 20", satisfied: true },
  autoridade: { value: "sócia, decide com o marido", satisfied: true },
};
