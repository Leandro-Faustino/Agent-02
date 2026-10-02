-- Agente SDR com IA — esquema inicial
-- Isolamento por cliente com Row Level Security (RNF-02), busca semântica com
-- pgvector, agendamentos com pg_cron + pg_net e segredos no Vault (RNF-06).

create extension if not exists vector;
create extension if not exists btree_gist;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-------------------------------------------------------------------------------
-- Empresas clientes e acesso por papel
-------------------------------------------------------------------------------

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create type public.member_role as enum ('dono', 'admin', 'vendedor', 'operador');

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'admin',
  seller_id text,
  primary key (tenant_id, user_id)
);

create or replace function public.is_member(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tenant_members m where m.tenant_id = t and m.user_id = auth.uid());
$$;

-- RF-01 a RF-09: configuração validada pela aplicação (TenantConfigSchema)
create table public.tenant_configs (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  config jsonb not null,
  approved boolean not null default false,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  updated_at timestamptz not null default now()
);

-------------------------------------------------------------------------------
-- WhatsApp (RF-33, RF-38)
-------------------------------------------------------------------------------

create table public.whatsapp_numbers (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  phone_number_id text not null unique,
  waba_id text not null,
  display_phone text not null,
  -- Token de acesso guardado no Vault; aqui só o id do segredo.
  access_token_secret_id uuid not null,
  quality text not null default 'UNKNOWN',
  messaging_limit text not null default 'UNKNOWN',
  paused boolean not null default false,
  blocks_last_7d int not null default 0,
  checked_at timestamptz
);

create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  language text not null default 'pt_BR',
  purpose text not null check (purpose in ('follow_up','nutricao','reengajamento','lembrete','primeiro_contato','gatilho')),
  category text not null default 'MARKETING',
  status text not null default 'pendente' check (status in ('aprovado','pendente','rejeitado')),
  body text not null,
  variables text[] not null default '{}',
  unique (tenant_id, name, language)
);

create table public.send_counters (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  day date not null,
  sent int not null default 0,
  primary key (tenant_id, day)
);

-------------------------------------------------------------------------------
-- Leads, mensagens e CRM (RF-40, RF-41)
-------------------------------------------------------------------------------

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone text not null,
  -- Memória estruturada completa do lead (camada Lead da base de conhecimento)
  data jsonb not null,
  stage text not null,
  flow_state text not null,
  source text not null,
  priority int not null default 5,
  score int not null default 0,
  opted_out boolean not null default false,
  -- RNF-11: origem e base legal
  legal_basis text not null check (legal_basis in ('consentimento','legitimo_interesse')),
  origin_note text,
  next_action_at timestamptz,
  processing_until timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, phone)
);
create index leads_due_idx on public.leads (next_action_at, priority) where next_action_at is not null and not opted_out;
create index leads_stage_idx on public.leads (tenant_id, stage);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  role text not null check (role in ('lead','agente','vendedor','sistema')),
  text text not null default '',
  kind text not null default 'text',
  media jsonb,
  template_name text,
  external_id text unique,
  -- Caixa de entrada durável (RNF-03): processada = respondida pelo agente
  processed boolean not null default true,
  at timestamptz not null default now()
);
create index messages_lead_idx on public.messages (lead_id, at);
create index messages_pending_idx on public.messages (lead_id) where role = 'lead' and not processed;

create table public.events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}',
  at timestamptz not null default now()
);
create index events_tenant_idx on public.events (tenant_id, type, at);

-- RNF-04: log por turno (entrada, estado, saída estruturada, ferramentas, custo)
create table public.turn_logs (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  at timestamptz not null default now(),
  input text,
  state_before text,
  state_after text,
  analysis jsonb,
  tools jsonb,
  output jsonb,
  guardrail_violations text[] not null default '{}',
  cost_usd numeric(10,6) not null default 0
);
create index turn_logs_tenant_idx on public.turn_logs (tenant_id, at);

-- RF-32 / RF-45: fila de revisão humana
create table public.review_queue (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  reason text not null,
  payload jsonb not null default '{}',
  status text not null default 'aberto' check (status in ('aberto','resolvido','descartado')),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-------------------------------------------------------------------------------
-- Agenda (RF-06, RF-29): reserva atômica, sem dupla marcação
-------------------------------------------------------------------------------

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  seller_id text not null,
  lead_id uuid references public.leads(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'agendada',
  source text not null default 'agente',
  created_at timestamptz not null default now(),
  constraint bookings_no_overlap exclude using gist (
    tenant_id with =, seller_id with =, tstzrange(starts_at, ends_at) with &&
  ) where (status <> 'cancelada')
);

-------------------------------------------------------------------------------
-- Base de conhecimento por cliente (RAG isolado, RNF-02)
-------------------------------------------------------------------------------

create table public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title text not null,
  source text not null,
  reviewed boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  document_id uuid not null references public.kb_documents(id) on delete cascade,
  content text not null,
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('portuguese', content)) stored
);
create index kb_chunks_tenant_idx on public.kb_chunks (tenant_id);
create index kb_chunks_tsv_idx on public.kb_chunks using gin (tsv);
create index kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding vector_cosine_ops);

-- Busca híbrida: vetor quando houver embedding da pergunta, texto caso contrário.
-- Filtra SEMPRE por tenant (nenhuma consulta cruza clientes).
create or replace function public.match_kb_chunks(p_tenant uuid, p_query text, p_embedding vector(1024) default null, p_k int default 5)
returns table (id uuid, content text, source text, score float)
language sql stable set search_path = public as $$
  with v as (
    select c.id, c.content, d.title as source, 1 - (c.embedding <=> p_embedding) as score
    from kb_chunks c join kb_documents d on d.id = c.document_id
    where p_embedding is not null and c.tenant_id = p_tenant and c.embedding is not null
    order by c.embedding <=> p_embedding
    limit p_k
  ),
  q as (
    -- Qualquer termo da pergunta (OU), ranqueado por relevância
    select nullif(replace(plainto_tsquery('portuguese', p_query)::text, '&', '|'), '')::tsquery as tsq
  ),
  t as (
    select c.id, c.content, d.title as source, ts_rank(c.tsv, q.tsq)::float as score
    from kb_chunks c join kb_documents d on d.id = c.document_id, q
    where c.tenant_id = p_tenant and q.tsq is not null and c.tsv @@ q.tsq
    order by score desc
    limit p_k
  )
  select * from v
  union all
  select * from t where not exists (select 1 from v)
  limit p_k;
$$;

-------------------------------------------------------------------------------
-- Fila de trabalho (RF-21, RF-36)
-------------------------------------------------------------------------------

-- Leads com mensagens pendentes cuja última mensagem tem mais de N segundos
-- (mensagens picadas viram um único turno). Reserva com skip locked.
create or replace function public.claim_debounced_leads(p_limit int default 20)
returns setof uuid language plpgsql security definer set search_path = public as $$
begin
  return query
  update leads l set processing_until = now() + interval '2 minutes'
  where l.id in (
    select l2.id from leads l2
    join lateral (
      select max(m.at) as last_at from messages m
      where m.lead_id = l2.id and m.role = 'lead' and not m.processed
    ) p on p.last_at is not null
    join tenant_configs tc on tc.tenant_id = l2.tenant_id
    where (l2.processing_until is null or l2.processing_until < now())
      and p.last_at < now() - make_interval(secs => coalesce((tc.config->'limits'->>'debounceSeconds')::int, 8))
    order by l2.priority, p.last_at
    limit p_limit
    for update of l2 skip locked
  )
  returning l.id;
end $$;

create or replace function public.claim_due_leads(p_limit int default 50)
returns setof public.leads language plpgsql security definer set search_path = public as $$
begin
  return query
  update leads l set processing_until = now() + interval '2 minutes'
  where l.id in (
    select id from leads
    where next_action_at <= now()
      and (processing_until is null or processing_until < now())
    order by priority, next_action_at
    limit p_limit
    for update skip locked
  )
  returning l.*;
end $$;

create or replace function public.increment_send_counter(p_tenant uuid)
returns void language sql security definer set search_path = public as $$
  insert into send_counters (tenant_id, day, sent) values (p_tenant, current_date, 1)
  on conflict (tenant_id, day) do update set sent = send_counters.sent + 1;
$$;

create or replace function public.whatsapp_token(p_tenant uuid)
returns text language sql security definer set search_path = public, vault as $$
  select s.decrypted_secret from whatsapp_numbers w
  join vault.decrypted_secrets s on s.id = w.access_token_secret_id
  where w.tenant_id = p_tenant;
$$;
revoke execute on function public.whatsapp_token(uuid) from public, anon, authenticated;
revoke execute on function public.claim_debounced_leads(int) from public, anon, authenticated;
revoke execute on function public.claim_due_leads(int) from public, anon, authenticated;
revoke execute on function public.increment_send_counter(uuid) from public, anon, authenticated;

-------------------------------------------------------------------------------
-- LGPD (RNF-12, RNF-13) e auditoria (RF-45)
-------------------------------------------------------------------------------

-- Anonimiza conversas de leads descartados após o prazo configurado
create or replace function public.apply_retention()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with targets as (
    select l.id from leads l join tenant_configs tc on tc.tenant_id = l.tenant_id
    where l.stage = 'descartado' and l.anonymized_at is null
      and l.updated_at < now() - make_interval(days => coalesce((tc.config->'limits'->>'retentionDays')::int, 180))
  ), msgs as (
    update messages set text = '[anonimizado]', media = null where lead_id in (select id from targets) returning 1
  ), logs as (
    update turn_logs set input = '[anonimizado]', output = null, analysis = null where lead_id in (select id from targets) returning 1
  )
  update leads set
    phone = 'anon-' || left(md5(phone), 12),
    data = jsonb_build_object('id', id, 'tenantId', tenant_id, 'stage', stage, 'anonymized', true),
    origin_note = null,
    anonymized_at = now()
  where id in (select id from targets);
  get diagnostics n = row_count;
  return n;
end $$;

-- Amostra semanal de oportunidades para revisão humana
create or replace function public.weekly_audit_sample(p_per_tenant int default 5)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into review_queue (tenant_id, lead_id, reason, payload)
  select tenant_id, id, 'auditoria_semanal', jsonb_build_object('stage', stage, 'score', score)
  from (
    select l.*, row_number() over (partition by tenant_id order by random()) rn
    from leads l
    where l.stage in ('reuniao_agendada','reuniao_realizada','oportunidade_aceita','devolvida')
      and l.updated_at > now() - interval '7 days'
  ) s where rn <= p_per_tenant;
  get diagnostics n = row_count;
  return n;
end $$;

-------------------------------------------------------------------------------
-- Painel (RF-43): métricas por mês
-------------------------------------------------------------------------------

create or replace view public.tenant_metrics with (security_invoker = true) as
with leads_m as (
  select tenant_id, date_trunc('month', created_at) as month, count(*) as leads,
    count(*) filter (where stage in ('reuniao_agendada','reuniao_realizada','oportunidade_aceita','devolvida')) as handed_off,
    count(*) filter (where stage = 'oportunidade_aceita') as accepted,
    count(*) filter (where stage = 'devolvida') as returned,
    count(*) filter (where opted_out) as opt_outs,
    count(*) filter (where source <> 'inbound') as outbound,
    count(*) filter (where source <> 'inbound' and data->'signals' ? 'respondeu') as outbound_replied
  from leads group by 1, 2
), meetings_m as (
  select tenant_id, date_trunc('month', starts_at) as month,
    count(*) filter (where status in ('realizada')) as held,
    count(*) filter (where status in ('realizada','no_show')) as due
  from bookings group by 1, 2
), cost_m as (
  select tenant_id, date_trunc('month', at) as month, sum(cost_usd) as ai_cost_usd, count(distinct lead_id) as conversations
  from turn_logs group by 1, 2
)
select l.tenant_id, l.month, l.leads, l.handed_off, l.accepted, l.returned, l.opt_outs,
  round(100.0 * l.accepted / nullif(l.leads, 0), 1) as lead_to_accepted_pct,
  round(100.0 * l.accepted / nullif(l.accepted + l.returned, 0), 1) as seller_accept_pct,
  round(100.0 * m.held / nullif(m.due, 0), 1) as show_rate_pct,
  round(100.0 * l.opt_outs / nullif(c.conversations, 0), 2) as opt_outs_per_100,
  round(100.0 * l.outbound_replied / nullif(l.outbound, 0), 1) as first_reply_pct,
  c.ai_cost_usd,
  round(c.ai_cost_usd / nullif(l.accepted, 0), 4) as ai_cost_per_opportunity
from leads_m l
left join meetings_m m using (tenant_id, month)
left join cost_m c using (tenant_id, month);

create or replace view public.objection_stats with (security_invoker = true) as
select l.tenant_id, o->>'type' as objection, count(*) as total,
  count(*) filter (where (o->>'reverted')::boolean) as reverted,
  round(100.0 * count(*) filter (where (o->>'reverted')::boolean) / count(*), 1) as reversal_pct
from leads l, jsonb_array_elements(l.data->'objections') o
group by 1, 2;

-------------------------------------------------------------------------------
-- Row Level Security (RNF-02)
-------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['tenant_configs','whatsapp_numbers','whatsapp_templates','send_counters','leads','messages',
                           'events','turn_logs','review_queue','bookings','kb_documents','kb_chunks']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member(tenant_id))', t || '_read', t);
  end loop;
end $$;

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
create policy tenants_read on public.tenants for select to authenticated using (public.is_member(id));
create policy members_read on public.tenant_members for select to authenticated using (user_id = auth.uid());

-- Escrita pelo painel: configuração, modelos, base e fila de revisão.
create policy tenant_configs_write on public.tenant_configs for all to authenticated
  using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));
create policy templates_write on public.whatsapp_templates for all to authenticated
  using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));
create policy kb_documents_write on public.kb_documents for all to authenticated
  using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));
create policy review_write on public.review_queue for update to authenticated
  using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));
-- Agente, webhooks e workers usam a service role (ignora RLS) no servidor.
