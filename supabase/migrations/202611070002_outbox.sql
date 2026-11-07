
-- Remaining persisted work makes Telegram retry the webhook instead of losing queued effects.
create or replace function public.nr_pending_count()
returns integer language sql security definer set search_path=pg_catalog,requests_app as $$
 select count(*)::integer from requests_app.outbox where state in ('pending','processing');
$$;
revoke all on function public.nr_pending_count() from public,anon,authenticated;
grant execute on function public.nr_pending_count() to service_role;
notify pgrst, 'reload schema';

