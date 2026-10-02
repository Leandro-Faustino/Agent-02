import type { ObjectionResponse, QualificationCriterion } from "../types";

/**
 * Catálogo inicial de objeções (cada empresa revisa as suas, RF-05).
 * "{{slots}}" é substituído pelos dois horários reais da agenda (RF-14).
 */
export const DEFAULT_OBJECTIONS: ObjectionResponse[] = [
  {
    type: "sem_interesse",
    label: "Não tenho interesse",
    edge: "Faz sentido.",
    disrupt: "A maioria responde isso na primeira mensagem; por isso a conversa é curta, só para ver se faz sentido.",
    ask: "{{slots}}",
  },
  {
    type: "sem_tempo",
    label: "Estou sem tempo",
    edge: "Imaginei.",
    disrupt: "Por isso quero achar um horário que caiba na sua agenda.",
    ask: "{{slots}}",
  },
  {
    type: "manda_informacoes",
    label: "Me manda informações",
    edge: "Mando, sim.",
    disrupt: "Para não te afogar em material, o que exatamente você quer ver?",
    ask: "Com isso, 15 minutos bastam para montar algo sob medida. {{slots}}",
  },
  {
    type: "ja_tem_fornecedor",
    label: "Já temos fornecedor",
    edge: "Ótimo.",
    disrupt: "Se está funcionando bem, não faz sentido trocar; a conversa serve como referência de comparação.",
    ask: "{{slots}}",
  },
  {
    type: "sem_orcamento",
    label: "Não tenho orçamento",
    edge: "Entendo.",
    disrupt: "Outros clientes diziam o mesmo até verem quanto custava não resolver o problema.",
    ask: "{{slots}}",
  },
  {
    type: "faz_internamente",
    label: "Fazemos internamente",
    edge: "Faz sentido.",
    disrupt: "A maioria dos nossos clientes tem equipe interna; nós complementamos.",
    ask: "{{slots}}",
  },
  {
    type: "nao_decide",
    label: "Não sou eu quem decide",
    edge: "Obrigado por avisar.",
    disrupt: "Quem cuida disso aí?",
    ask: "Posso falar com essa pessoa e mencionar a nossa conversa?",
  },
  {
    type: "ja_usou_nao_deu_certo",
    label: "Já usamos e não deu certo",
    edge: "Que pena.",
    disrupt: "É exatamente o que quero entender: o que aconteceu?",
    ask: "Vale uma conversa para ouvir o caso. {{slots}}",
  },
  // RF-16 — objeções de próximo passo
  {
    type: "manda_email",
    label: "Me manda por e-mail",
    edge: "Mando, sim.",
    disrupt: "O e-mail mostra o que fazemos; a conversa mostra o que faria sentido para vocês, com base no que você me contou.",
    ask: "{{slots}}",
  },
  {
    type: "me_chama_depois",
    label: "Me chama semana que vem",
    edge: "Combinado.",
    disrupt: "Para não ficar solto, já deixo reservado.",
    ask: "{{slots}}",
  },
  {
    type: "eu_te_chamo",
    label: "Eu te chamo",
    edge: "Perfeito.",
    disrupt: "Para você não precisar lembrar disso, deixo um horário reservado e, se não servir, a gente troca.",
    ask: "{{slots}}",
  },
];

/** Modelo padrão de critérios (RF-04), inspirado nos critérios da Marketo. */
export const DEFAULT_QUALIFICATION: QualificationCriterion[] = [
  { id: "encaixe_pic", label: "Encaixe no PIC", question: "Segmento, porte e cargo batem com o perfil?", required: true },
  { id: "dor", label: "Dor", question: "Existe um problema claro que a oferta resolve?", required: true },
  { id: "autoridade", label: "Autoridade", question: "A pessoa decide ou influencia a compra?", required: true },
  { id: "situacao_atual", label: "Situação atual", question: "Quais processos e ferramentas usa hoje?", required: false },
  { id: "prazo", label: "Prazo", question: "Quando precisa resolver?", required: false },
  { id: "gatilho", label: "Gatilho", question: "Aconteceu algo que exige ação agora?", required: false },
];

/** RF-26 — palavras de opt-out. */
export const OPT_OUT_PATTERNS = [
  /^\s*(pare|parar|sair|stop|cancelar|descadastrar)\s*[.!]*\s*$/i,
  /n[ãa]o quero mais/i,
  /para de me mandar/i,
  /pare de me mandar/i,
  /me tir[ae] (da|dessa) lista/i,
  /n[ãa]o me mande mais/i,
  /n[ãa]o (me )?(mande|envie) mais mensage/i,
];

/** RF-20 — pedido explícito de pessoa. */
export const HUMAN_REQUEST_PATTERNS = [
  /falar com (um|uma)? ?(humano|pessoa|atendente|vendedor|algu[ée]m)/i,
  /quero (um|uma) (humano|pessoa|atendente)/i,
  /atendente humano/i,
];

/** RNF-07 — pergunta se é robô. */
export const BOT_QUESTION_PATTERNS = [
  /(voc[êe]|vc) [ée] (um )?(rob[ôo]|bot|ia|intelig[êe]ncia artificial|m[áa]quina|humano|de verdade|real)/i,
  /(isso|aqui) [ée] (um )?(rob[ôo]|bot)/i,
  /estou falando com (um )?(rob[ôo]|bot|humano|pessoa)/i,
];
