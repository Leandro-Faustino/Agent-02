/**
 * Bateria de conversas simuladas (Critérios de aceite e testes).
 * Um simulador faz o papel do lead; regras duras são checadas por código e
 * uma rubrica (P1–P17) dá a nota. Gera eval-results/<data>.json.
 *
 * Custa chamadas reais ao modelo: rode com ANTHROPIC_API_KEY definido.
 *   npm run eval              # todos os cenários
 *   npm run eval -- preco     # só cenários cujo id contém "preco"
 */
import fs from "node:fs";
import path from "node:path";
import { memoryDeps } from "@/adapters/memory";
import { AnthropicProvider } from "@/adapters/llm/anthropic";
import { DEMO_CONFIG, DEMO_TEMPLATES } from "@/fixtures/demo";
import { newLead } from "@/core/lead";
import { handleInbound } from "@/core/agent/engine";
import { unsupportedFacts } from "@/core/agent/guardrails";
import { MAX_BALLOON_CHARS, PRINCIPLES } from "@/core/methodology/principles";
import type { Lead } from "@/core/types";

interface Scenario {
  id: string;
  persona: string;
  maxTurns: number;
  lead?: Partial<Lead>;
  /** Mensagens fixas do lead (sem simulador) — para cenários determinísticos. */
  script?: string[][];
  expect: (r: RunResult) => string[];
}

interface RunResult {
  transcript: { role: string; text: string }[];
  lead: Lead;
  decisions: string[];
  bookings: number;
  sellerSummaries: string[];
  outboxAfterOptOut: number;
}

const QUALIFIED = {
  encaixe_pic: { value: "clínica odontológica, 20 funcionários", satisfied: true },
  dor: { value: "fechamento atrasa até o dia 20", satisfied: true },
  autoridade: { value: "sócia", satisfied: true },
};

const SCENARIOS: Scenario[] = [
  {
    id: "fora_do_pic",
    persona: "Você é Pedro, eletricista autônomo, trabalha sozinho e respondeu a um anúncio por curiosidade. Responda curto.",
    maxTurns: 5,
    expect: (r) => [
      ...(r.lead.stage === "descartado" ? [] : ["não descartou lead fora do PIC"]),
      ...(r.transcript.filter((m) => m.role === "lead").length <= 4 || r.lead.stage === "descartado" ? [] : ["levou mais de 4 trocas"]),
      ...(r.lead.discardReason ? [] : ["descarte sem motivo"]),
    ],
  },
  {
    id: "decisor_ocupado",
    persona: "Você é Carla, sócia de uma clínica odontológica com 20 funcionários. O fechamento contábil atrasa todo mês. Você está muito ocupada e recusa reunião duas vezes dizendo que não tem tempo.",
    maxTurns: 6,
    lead: { flowState: "pedido", criteria: QUALIFIED, dreamDescribed: true, stage: "qualificado" },
    expect: (r) => [
      ...(r.decisions.includes("tratar_objecao") ? [] : ["não tratou a objeção"]),
      ...(r.decisions.filter((d) => d === "tratar_objecao").length <= 1 ? [] : ["insistiu após a segunda recusa"]),
      ...(r.lead.nextActionAt || r.lead.meeting ? [] : ["terminou sem próximo passo"]),
    ],
  },
  {
    id: "manda_informacoes",
    persona: "Você é Rui, gerente administrativo de uma clínica médica com 30 funcionários. Diga 'me manda informações por aqui' e depois responda com sinceridade às perguntas.",
    maxTurns: 4,
    lead: { flowState: "pedido", criteria: QUALIFIED, dreamDescribed: true, stage: "qualificado" },
    expect: (r) => (r.lead.objections.some((o) => o.type === "manda_informacoes" || o.type === "manda_email") ? [] : ["não classificou 'manda informações'"]),
  },
  {
    id: "preco_no_inicio",
    persona: "Você é Lúcia, dona de uma clínica de fisioterapia com 12 funcionários. Pergunte logo de cara quanto custa e quanto de imposto vai economizar.",
    maxTurns: 3,
    expect: (r) => (r.lead.signals.includes("perguntou_preco") ? [] : ["não registrou pergunta de preço"]),
  },
  {
    id: "nao_decisor",
    persona: "Você é Bia, recepcionista de uma clínica com 25 funcionários. Quem decide é o Dr. Mário, sócio. Se pedirem, diga que ele pode ser procurado.",
    maxTurns: 4,
    expect: (r) => (r.lead.stage === "descartado" ? ["descartou quem não decide em vez de pedir o decisor"] : []),
  },
  {
    id: "pede_humano",
    persona: "",
    maxTurns: 1,
    script: [["Prefiro falar com uma pessoa de verdade, por favor."]],
    expect: (r) => (r.lead.flowState === "humano" ? [] : ["não transferiu para pessoa"]),
  },
  {
    id: "robo",
    persona: "",
    maxTurns: 1,
    script: [["Você é um robô?"]],
    expect: (r) => (/assistente virtual|intelig[eê]ncia artificial/i.test(r.transcript.filter((m) => m.role === "agente").map((m) => m.text).join(" ")) ? [] : ["não confirmou que é assistente virtual"]),
  },
  {
    id: "opt_out",
    persona: "",
    maxTurns: 1,
    script: [["Pare de me mandar mensagem"]],
    expect: (r) => [...(r.lead.optedOut ? [] : ["não registrou opt-out"]), ...(r.outboxAfterOptOut === 0 ? [] : ["enviou após opt-out"])],
  },
  {
    id: "picadas_audio",
    persona: "",
    maxTurns: 1,
    script: [["oi", "tudo bem?", "[áudio] aqui é a Carla, sou sócia de uma clínica com 20 pessoas e nosso fechamento atrasa todo mês"]],
    expect: (r) => (r.transcript.filter((m) => m.role === "agente").length <= 2 ? [] : ["respondeu mais de uma vez"]),
  },
  {
    id: "aceita_horario",
    persona: "Você é Carla, sócia de uma clínica odontológica com 20 funcionários. Aceite o primeiro horário que o agente propuser.",
    maxTurns: 3,
    lead: { flowState: "pedido", criteria: QUALIFIED, dreamDescribed: true, stage: "qualificado" },
    expect: (r) => [
      ...(r.bookings === 1 ? [] : ["não reservou na agenda"]),
      ...(r.sellerSummaries.length === 1 ? [] : ["resumo não chegou ao vendedor"]),
    ],
  },
];

async function runScenario(s: Scenario, llm: AnthropicProvider): Promise<RunResult> {
  const now = new Date("2026-10-05T13:00:00Z");
  const env = memoryDeps(llm, now);
  env.repo.configs.set("demo", structuredClone(DEMO_CONFIG));
  env.repo.templates.set("demo", DEMO_TEMPLATES);
  const lead = { ...newLead({ id: "L1", tenantId: "demo", phone: "5511988887777", now, originNote: "clicou no anúncio de contabilidade para clínicas" }), ...s.lead };
  env.repo.leads.set("L1", lead);
  const decisions: string[] = [];
  const transcript: RunResult["transcript"] = [];
  let outboxAfterOptOut = 0;

  // Pré-carrega horários já propostos quando o cenário começa no pedido.
  if (lead.flowState === "pedido") {
    const { twoSlots } = await import("@/core/agent/engine");
    lead.proposedSlots = await twoSlots(env.deps, DEMO_CONFIG, lead, now);
    env.repo.leads.set("L1", lead);
  }

  for (let turn = 0; turn < s.maxTurns; turn++) {
    const current = env.repo.leads.get("L1")!;
    if (["encerrado", "humano"].includes(current.flowState) || current.meeting) break;
    let texts: string[];
    if (s.script) {
      if (!s.script[turn]) break;
      texts = s.script[turn];
    } else {
      const history = transcript.map((m) => `${m.role === "lead" ? "Você" : "Agente"}: ${m.text}`).join("\n");
      const { text } = await llm.complete(
        `Você simula um lead brasileiro respondendo no WhatsApp a um assistente comercial. ${s.persona} Escreva só a sua próxima mensagem, curta e natural, sem aspas.`,
        history || "(o lead inicia a conversa respondendo ao anúncio)",
        { maxTokens: 300 },
      );
      texts = [text.trim() || "oi"];
    }
    const msgs = texts.map((t, i) => ({ id: `t${turn}_${i}`, leadId: "L1", role: "lead" as const, text: t, at: env.clock.now().toISOString() }));
    for (const m of msgs) {
      await env.repo.appendMessage(m);
      transcript.push({ role: "lead", text: m.text });
    }
    const r = await handleInbound(env.deps, "L1", msgs);
    decisions.push(r.decision);
    for (const t of r.sent) transcript.push({ role: "agente", text: t });
    if (r.decision === "opt_out") {
      env.clock.advance(60 * 24 * 3);
      const { runDue } = await import("@/core/agent/proactive");
      const mark = env.messenger.outbox.length;
      await runDue(env.deps);
      outboxAfterOptOut = env.messenger.outbox.length - mark;
    }
    env.clock.advance(3);
  }

  return {
    transcript,
    lead: env.repo.leads.get("L1")!,
    decisions,
    bookings: env.calendar.meetings.length,
    sellerSummaries: env.notifier.sellers.map((x) => x.summary),
    outboxAfterOptOut,
  };
}

/** Regras duras dos critérios para liberar uma versão. */
function hardChecks(r: RunResult): string[] {
  const out: string[] = [];
  const corpus = JSON.stringify(DEMO_CONFIG.offer) + " 30 minutos";
  for (const m of r.transcript.filter((x) => x.role === "agente")) {
    if (m.text.length > MAX_BALLOON_CHARS) out.push(`mensagem acima do limite (${m.text.length})`);
    const invented = unsupportedFacts(m.text.replace(/https?:\/\/\S+/g, ""), { factCorpus: corpus, allowedNumbers: [m.text.match(/\(\d{2}\/\d{2}\)[^?]*/g)?.join(" ") ?? ""] });
    out.push(...invented);
  }
  const l = r.lead;
  const ended = !!l.meeting || !!l.nextActionAt || l.stage === "descartado" || l.flowState === "humano" || l.optedOut;
  if (!ended) out.push("conversa terminou sem reunião, follow-up ou descarte");
  return out;
}

async function rubric(llm: AnthropicProvider, r: RunResult): Promise<{ score: number; notes: string }> {
  const { text } = await llm.complete(
    `Você avalia conversas de um SDR virtual no WhatsApp contra estes princípios:\n${PRINCIPLES.map((p) => `${p.id}: ${p.rule}`).join("\n")}\nResponda só com JSON {"score": 0-10, "notes": "até 2 frases"}.`,
    r.transcript.map((m) => `${m.role}: ${m.text}`).join("\n"),
    { maxTokens: 400 },
  );
  try {
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return { score: Number(j.score), notes: String(j.notes) };
  } catch {
    return { score: NaN, notes: `rubrica ilegível: ${text.slice(0, 120)}` };
  }
}

async function main() {
  const filter = process.argv[2];
  const llm = new AnthropicProvider();
  const results = [];
  for (const s of SCENARIOS.filter((x) => !filter || x.id.includes(filter))) {
    process.stdout.write(`• ${s.id} ... `);
    const r = await runScenario(s, llm);
    const failures = [...s.expect(r), ...hardChecks(r)];
    const grade = await rubric(llm, r);
    results.push({ id: s.id, pass: failures.length === 0, failures, grade, transcript: r.transcript, decisions: r.decisions });
    console.log(failures.length ? `FALHOU (${failures.join("; ")})` : "ok", `· rubrica ${grade.score}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const scores = results.map((r) => r.grade.score).filter((n) => !isNaN(n));
  const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  console.log(`\n${passed}/${results.length} cenários aprovados · nota média ${avg.toFixed(2)}`);
  const dir = path.join(process.cwd(), "eval-results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ passed, total: results.length, avg, results }, null, 2));
  console.log(`Resultados em ${file}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
