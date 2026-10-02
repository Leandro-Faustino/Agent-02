import { TenantConfigSchema, type TenantConfig } from "@/core/types";
import { DEFAULT_OBJECTIONS, DEFAULT_QUALIFICATION } from "@/core/methodology/defaults";
import type { WhatsAppTemplate } from "@/core/ports";

/** Empresa de demonstração: contabilidade para clínicas. Usada em testes, simulador e seed. */
export const DEMO_CONFIG: TenantConfig = TenantConfigSchema.parse({
  tenantId: "demo",
  approved: true,
  goal: "reuniao",
  profiles: [
    {
      id: "clinicas",
      name: "Clínicas médicas e odontológicas",
      positive: [
        "Clínica médica ou odontológica",
        "De 5 a 80 funcionários",
        "Faturamento mensal acima de R$ 80 mil",
        "Fala com sócio, diretor ou gerente administrativo",
      ],
      negative: ["Profissional autônomo sem equipe", "Hospital de grande porte", "Empresa fora da área da saúde"],
      decisionRoles: ["sócio", "sócia", "diretor", "diretora", "gerente administrativo", "dono", "dona"],
      pains: {
        challenges: ["fechamento do mês atrasado", "impostos pagos a mais por enquadramento errado"],
        sleeplessNights: ["multa da Receita"],
        frustrations: ["contador que só aparece para cobrar"],
        fears: ["fiscalização"],
        mostImportant: ["previsibilidade do caixa"],
        realWants: ["saber quanto sobra no fim do mês sem planilha"],
      },
      bridges: [
        "clínicas do seu porte costumam pagar imposto a mais por enquadramento errado",
        "o fechamento atrasado tira a previsibilidade do caixa",
      ],
    },
  ],
  offer: {
    product: "Contabilidade consultiva para clínicas",
    summary: "Contabilidade com fechamento mensal até o dia 5 e revisão tributária no primeiro mês.",
    authorizedPrices: [{ label: "Planos a partir de", value: "R$ 890 por mês" }],
    differentiators: ["Fechamento até o dia 5", "Revisão tributária no primeiro mês", "Especialista dedicado"],
    cases: [{ client: "Clínica Sorriso Pleno", result: "reduziu o fechamento de 12 para 4 dias", authorized: true }],
    testimonials: [],
    provenNumbers: ["Mais de 120 clínicas atendidas"],
    faq: [{ q: "Atendem fora de São Paulo?", a: "Sim, o atendimento é digital em todo o Brasil." }],
  },
  qualification: DEFAULT_QUALIFICATION,
  objections: DEFAULT_OBJECTIONS,
  meetings: {
    sellers: [
      {
        id: "marcos",
        name: "Marcos",
        phone: "5511999990001",
        availability: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: "09:00", to: "17:00" })),
      },
    ],
    durationMinutes: 30,
    bufferMinutes: 15,
    minLeadTimeHours: 2,
    horizonDays: 10,
    format: "video",
    meetingLink: "https://meet.exemplo.com.br/lumen",
  },
  persona: { agentName: "Ana", companyName: "Lumen Contábil", formality: "neutro", forbiddenWords: ["barato"] },
  limits: { sendWindow: {} },
});

export const DEMO_TEMPLATES: WhatsAppTemplate[] = [
  { name: "follow_up_v1", language: "pt_BR", purpose: "follow_up", status: "aprovado", body: "Oi, {{1}}, aqui é da Lumen Contábil. {{2}}", variables: ["nome", "gancho"] },
  { name: "nutricao_v1", language: "pt_BR", purpose: "nutricao", status: "aprovado", body: "Oi, {{1}}. {{2}}", variables: ["nome", "gancho"] },
  { name: "lembrete_v1", language: "pt_BR", purpose: "lembrete", status: "aprovado", body: "Oi, {{1}}, lembrete da nossa conversa {{2}}. Link: {{3}}", variables: ["nome", "horario", "link"] },
  { name: "reengajamento_v1", language: "pt_BR", purpose: "reengajamento", status: "aprovado", body: "Oi, {{1}}, aqui é a {{2}}, assistente virtual da {{3}}. Você {{4}}. Como está o fechamento do mês aí hoje?", variables: ["nome", "agente", "empresa", "origem"] },
];
