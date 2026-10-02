/**
 * Converse com o agente no terminal, sem WhatsApp nem Supabase.
 * Usa a empresa de demonstração e o modelo real (ANTHROPIC_API_KEY).
 *   npm run simulate
 * Comandos: /estado (memória do lead), /cadencia (roda follow-ups vencidos), /sair
 */
import readline from "node:readline/promises";
import { memoryDeps } from "@/adapters/memory";
import { AnthropicProvider } from "@/adapters/llm/anthropic";
import { DEMO_CONFIG, DEMO_TEMPLATES } from "@/fixtures/demo";
import { newLead } from "@/core/lead";
import { handleInbound } from "@/core/agent/engine";
import { runDue } from "@/core/agent/proactive";

async function main() {
  const env = memoryDeps(new AnthropicProvider(), new Date());
  env.repo.configs.set("demo", structuredClone(DEMO_CONFIG));
  env.repo.templates.set("demo", DEMO_TEMPLATES);
  env.repo.leads.set("L1", newLead({ id: "L1", tenantId: "demo", phone: "5511988887777", now: new Date(), originNote: "clicou no anúncio de contabilidade para clínicas" }));
  env.kb.docs.push({ tenantId: "demo", id: "kb1", source: "FAQ", content: "O fechamento mensal é entregue até o dia 5 útil. A revisão tributária acontece no primeiro mês de contrato." });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Você é o lead. Escreva como no WhatsApp. (/estado, /cadencia, /sair)\n");
  let n = 0;
  for (;;) {
    const line = (await rl.question("lead> ")).trim();
    if (!line) continue;
    if (line === "/sair") break;
    if (line === "/estado") {
      const l = env.repo.leads.get("L1")!;
      console.log({ estagio: l.stage, etapa: l.flowState, pontos: l.score, criterios: l.criteria, objecoes: l.objections.map((o) => o.type), proximo: l.nextActionAt, reuniao: l.meeting });
      continue;
    }
    if (line === "/cadencia") {
      env.clock.current = new Date(env.repo.leads.get("L1")!.nextActionAt ?? Date.now());
      const r = await runDue(env.deps);
      console.log(r, env.messenger.outbox.slice(-1));
      continue;
    }
    const msg = { id: `m${++n}`, leadId: "L1", role: "lead" as const, text: line, at: env.clock.now().toISOString() };
    await env.repo.appendMessage(msg);
    const r = await handleInbound(env.deps, "L1", [msg]);
    for (const t of r.sent) console.log(`ana> ${t}`);
    console.log(`     [decisão: ${r.decision} · etapa: ${r.lead.flowState}]`);
    env.clock.advance(2);
  }
  rl.close();
}

main();
