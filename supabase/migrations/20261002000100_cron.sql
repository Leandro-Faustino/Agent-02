-- Agendamentos (pg_cron) que chamam os workers da aplicação Next.js via pg_net.
-- Antes de aplicar, crie no Vault os segredos 'app_url' (ex.: https://sdr.exemplo.com)
-- e 'cron_secret' (mesmo valor de CRON_SECRET na aplicação):
--   select vault.create_secret('https://sdr.exemplo.com', 'app_url');
--   select vault.create_secret('<segredo>', 'cron_secret');

create or replace function public.call_worker(path text)
returns bigint language sql security definer set search_path = public, vault, net as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'app_url') || path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$$;
revoke execute on function public.call_worker(text) from public, anon, authenticated;

-- RF-36 / RNF-01: mensagens recebidas (com espera de mensagens picadas)
select cron.schedule('sdr-inbound', '5 seconds', $$select public.call_worker('/api/worker/inbound')$$);
-- RF-19, RF-22 a RF-25: cadência, nutrição, gatilhos, lembretes
select cron.schedule('sdr-cadence', '* * * * *', $$select public.call_worker('/api/worker/cadence')$$);
-- RF-38: qualidade e limite de cada número
select cron.schedule('sdr-number-health', '7 * * * *', $$select public.call_worker('/api/worker/health')$$);
-- RNF-13: retenção
select cron.schedule('sdr-retention', '17 3 * * *', $$select public.apply_retention()$$);
-- RF-45: amostra semanal para auditoria
select cron.schedule('sdr-weekly-audit', '23 6 * * 1', $$select public.weekly_audit_sample(5)$$);
