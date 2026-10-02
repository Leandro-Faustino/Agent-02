# Agente SDR com IA (WhatsApp, multiempresa)

Agente que conversa com leads pelo WhatsApp, qualifica contra o perfil de cliente ideal de cada empresa cliente e entrega ao vendedor oportunidades com o próximo passo marcado. Implementa o MVP do documento *Agente SDR com IA — Requisitos do Produto*.

Stack: **Next.js** (painel, APIs, webhooks), **Supabase** (Postgres + pgvector, RLS por cliente, pg_cron, Vault), **WhatsApp Cloud API** e **Claude** como modelo de linguagem, atrás de uma interface própria (RF-31).

## Como funciona um turno

```
WhatsApp ──webhook──▶ messages (caixa de entrada durável, RNF-03)
                           │  pg_cron a cada 5 s → /api/worker/inbound
                           ▼  espera mensagens picadas (RF-36), transcreve áudio/lê imagem e PDF (RF-35)
                     handleInbound
  1. pré-checagens por código: onboarding aprovado (P1), opt-out (RF-26), pedido de pessoa (RF-20)
  2. contexto: base do cliente (RAG isolado), dois horários reais da agenda, memória do lead
  3. modelo redige a resposta + saída estruturada (intenção, objeção, critérios, confiança…) — RF-28
  4. código decide a etapa na máquina de estados (RF-27); se a resposta não combina, redige de novo
  5. ferramentas: reserva na agenda ANTES de confirmar (RF-29); resumo ao vendedor (RF-18)
  6. revisor automático: tamanho, abreviações, clichês, links, emojis, uma pergunta, fatos fora da base,
     falsa urgência, "sou humano" (RF-34.6, RF-30, RNF-07/08). Reprovou duas vezes → pessoa assume
  7. efeitos: estágio no CRM, pontuação, próximo passo agendado (P16: nunca termina em aberto)
```

O modelo escreve e classifica; **o código decide** transições, horários, reservas, opt-out, escalonamento e cadência. Isso torna testáveis as regras que não podem falhar.

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `src/core/types.ts` | Esquema de configuração por cliente (RF-01 a RF-09, validado com zod) e modelo do lead |
| `src/core/methodology/` | Playbook próprio: princípios P1–P17, regras de escrita, exemplos bons/ruins, catálogo de objeções e critérios padrão, montagem do prompt em três camadas |
| `src/core/agent/engine.ts` | Turno de conversa |
| `src/core/agent/state-machine.ts` | Etapas e transições permitidas; decisão do código |
| `src/core/agent/guardrails.ts` | Revisor automático antes do envio |
| `src/core/agent/scheduling.ts` | Horários reais, distribuição entre vendedores, pedido assumido com dois horários |
| `src/core/agent/cadence.ts`, `proactive.ts` | Pirâmide de prioridade, follow-up, nutrição, gatilhos, fim de ciclo, lembretes, no-show, primeiro contato com opt-in |
| `src/core/agent/handoff.ts`, `scoring.ts`, `qualification.ts` | Passagem do bastão, pontuação 0–100, três testes |
| `src/adapters/` | Claude, Supabase (repositório, agenda, base de conhecimento), WhatsApp Cloud API, mídia, avisos por webhook, implementações em memória |
| `src/app/api/` | Webhook do WhatsApp, workers do pg_cron, APIs do painel |
| `src/app/painel/` | Painel: métricas, leads, conversa com resumo, onboarding |
| `supabase/migrations/` | Esquema, RLS, funções de fila, retenção LGPD, auditoria semanal, métricas e agendamentos |
| `tests/` | Cenários obrigatórios e testes de unidade (modelo roteirizado) |
| `scripts/eval.ts` | Bateria com simulador de lead e rubrica (modelo real) |

## Rodando localmente

```bash
npm install
npm test                 # 41 testes: cenários obrigatórios, revisor, agenda, cadência, webhook
npm run typecheck
ANTHROPIC_API_KEY=... npm run simulate   # conversar com o agente no terminal (empresa de demonstração)
ANTHROPIC_API_KEY=... npm run eval       # bateria de conversas simuladas (custa chamadas ao modelo)
```

## Implantação

1. **Supabase**: aplique `supabase/migrations/` (`supabase db push`). Antes da migração de cron, crie no Vault os segredos `app_url` e `cron_secret`:
   ```sql
   select vault.create_secret('https://seu-app.exemplo.com', 'app_url');
   select vault.create_secret('<mesmo valor de CRON_SECRET>', 'cron_secret');
   ```
2. **Variáveis**: copie `.env.example` para `.env.local` e preencha.
3. **Empresa cliente**: crie a linha em `tenants`, vincule usuários em `tenant_members`, guarde o token da Meta no Vault (`vault.create_secret(token, 'wa_<empresa>')`) e cadastre `whatsapp_numbers` com o id desse segredo.
4. **Webhook da Meta**: aponte para `https://seu-app/api/whatsapp/webhook` com o `WHATSAPP_VERIFY_TOKEN`.
5. **Onboarding**: no painel, em *Configuração*, cole a configuração (`npm run demo-config` gera um exemplo), corrija os erros apontados e aprove. Cadastre os modelos de mensagem (`POST /api/tenants/:id/templates`) com os propósitos `follow_up`, `nutricao`, `lembrete`, `reengajamento`/`primeiro_contato`; o worker de saúde sincroniza o status de aprovação.
6. Antes de lançar, rode `npm run eval` e confira os critérios de liberação.

## Rastreio dos requisitos

| Requisito | Onde |
| --- | --- |
| P1–P17 | `methodology/principles.ts` (instruções), `state-machine.ts` (P5, P7, P15, P16), `guardrails.ts` (P17), `scheduling.ts` (P12) |
| RF-01 a RF-09 | `TenantConfigSchema`; aprovação em `api/tenants/[id]/config` |
| RF-10 a RF-17 | Prompt por etapa (`playbook.ts`) + decisão do código + banco de objeções |
| RF-18 | `handoff.ts`; aceite/devolução em `verdict`; devolução vai para `review_queue` |
| RF-19 | Lembretes 24 h/1 h e no-show em `proactive.ts` |
| RF-20 | Pedido de pessoa, irritação, assunto sensível, confiança baixa, revisor reprovado |
| RF-21 a RF-26 | `cadence.ts`, `proactive.ts`, opt-out determinístico |
| RF-27 a RF-30 | `state-machine.ts`, `analysis.ts`, ferramentas no motor, `unsupportedFacts` |
| RF-31 | `LlmProvider` em `core/ports.ts`; `AnthropicProvider` é uma implementação |
| RF-32 / RF-45 | `review_queue`, `weekly_audit_sample()` |
| RF-33 a RF-39 | `adapters/whatsapp`, janela de 24 h, modelos, revisor, mídia, debounce, horário, saúde do número, opt-in |
| RF-40 a RF-43 | `events`, estágios, `scoring.ts`, views `tenant_metrics` e `objection_stats` |
| RNF-02 | RLS em todas as tabelas; busca na base sempre filtrada por cliente |
| RNF-04 / RNF-05 | `turn_logs` com análise, ferramentas e custo; custo por oportunidade no painel |
| RNF-07 a RNF-09 | Revisor + fluxo de escalonamento + flag de menor de idade |
| RNF-10 a RNF-13 | Base legal por lead, exportação/exclusão, `apply_retention()` |

## Escolhas e limites do MVP

- **Modelo**: Claude Opus 5.5 (`claude-opus-5-5`) com esforço `low` para manter a latência baixa, saída estruturada validada por esquema e *fallback* automático do lado do servidor em caso de recusa. Os modelos ficam em `LLM_MODEL_WRITER`/`LLM_MODEL_CLASSIFIER`. Recusa ou saída inválida viram confiança zero → pessoa assume.
- **Agenda**: agenda interna (disponibilidade na configuração + tabela `bookings` com restrição que impede dupla reserva). Google/Outlook ainda não estão integrados; podem gravar bloqueios na mesma tabela.
- **Embeddings**: Voyage AI quando `VOYAGE_API_KEY` existe; sem ela, a busca usa texto completo do Postgres.
- **Transcrição de áudio**: endpoint configurável (`TRANSCRIPTION_URL`, formato multipart compatível com Whisper). Sem ele, o áudio fica marcado como não lido e o agente responde ao restante.
- **Avisos ao vendedor**: registrados no CRM da plataforma e enviados por webhook assinado (`integrations.webhookUrl`). Mensagem direta ao vendedor pelo WhatsApp exige modelo aprovado e ficou fora.
- **Painel**: métricas, leads, conversa, ações do vendedor e editor de configuração em JSON com validação. Um formulário guiado de onboarding é o próximo passo natural.
- **Ainda não implementado**: testes A/B de mensagem (RF-44, previsto para a fase de Escala), taxa de ganho das oportunidades (depende de o CRM do cliente devolver o resultado da venda), métricas por mensagem-modelo (RF-34.7; os envios já ficam em `messages.template_name`).
- **Decisões em aberto do documento** (conexão direta ou BSP, cobrança, autoatendimento, validação jurídica da LGPD) não mudam o código atual; a conexão usa a Cloud API direto.
