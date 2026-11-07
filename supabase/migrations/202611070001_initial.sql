begin;
create schema if not exists requests_app;
revoke all on schema requests_app from public, anon, authenticated;

create table if not exists requests_app.tickets (
 id uuid primary key default gen_random_uuid(),
 number bigint generated always as identity unique,
 request_key uuid not null unique,
 name text not null check (char_length(name) between 1 and 80),
 subject text not null check (char_length(subject) between 1 and 120),
 body text not null check (char_length(body) between 5 and 2000),
 token_hash text not null unique,
 expires_at timestamptz not null default now() + interval '30 minutes',
 ip_hash text not null,
 client_chat_id bigint,
 status text not null default 'draft' check(status in ('draft','new','in_progress','done')),
 created_at timestamptz not null default now(),
 confirmed_at timestamptz,
 check ((status='draft' and client_chat_id is null) or (status<>'draft' and client_chat_id is not null))
);
create index if not exists tickets_rate on requests_app.tickets(ip_hash,created_at);
create index if not exists tickets_client on requests_app.tickets(client_chat_id,created_at desc);
create index if not exists tickets_status on requests_app.tickets(status,created_at desc);
create table if not exists requests_app.messages (
 id bigint generated always as identity primary key,
 ticket_id uuid not null references requests_app.tickets(id) on delete cascade,
 author text not null check(author in ('client','admin')),
 body text not null check(char_length(body) between 1 and 2000),
 update_id bigint not null unique,
 created_at timestamptz not null default now()
);
create index if not exists messages_ticket on requests_app.messages(ticket_id,id);
create table if not exists requests_app.updates (
 update_id bigint primary key, created_at timestamptz not null default now()
);
create table if not exists requests_app.outbox (
 id bigint generated always as identity primary key,
 effect_key text not null unique,
 chat_id bigint not null,
 kind text not null,
 data jsonb not null,
 state text not null default 'pending' check(state in ('pending','processing','sent','failed')),
 attempts integer not null default 0,
 lease_token uuid,
 leased_until timestamptz,
 error_code text,
 created_at timestamptz not null default now(),
 sent_at timestamptz
);
create index if not exists outbox_pending on requests_app.outbox(state,id);
create table if not exists requests_app.prompts (
 chat_id bigint not null, message_id bigint not null,
 ticket_id uuid not null references requests_app.tickets(id) on delete cascade,
 created_at timestamptz not null default now(),
 primary key(chat_id,message_id)
);
alter table requests_app.tickets enable row level security;
alter table requests_app.messages enable row level security;
alter table requests_app.updates enable row level security;
alter table requests_app.outbox enable row level security;
alter table requests_app.prompts enable row level security;
revoke all on all tables in schema requests_app from public,anon,authenticated;
revoke all on all sequences in schema requests_app from public,anon,authenticated;

create or replace function requests_app.ticket_json(t requests_app.tickets)
returns jsonb language sql immutable set search_path=pg_catalog,requests_app as $$
 select jsonb_build_object('id',t.id,'number',t.number,'name',t.name,'subject',t.subject,
 'body',t.body,'status',t.status,'created_at',t.created_at);
$$;
create or replace function requests_app.queue(k text,c bigint,typ text,d jsonb)
returns void language sql set search_path=pg_catalog,requests_app as $$
 insert into requests_app.outbox(effect_key,chat_id,kind,data) values(k,c,typ,d)
 on conflict(effect_key) do nothing;
$$;

create or replace function public.nr_create_draft(
 p_key uuid,p_name text,p_subject text,p_body text,p_hash text,p_ip_hash text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,requests_app as $$
declare t requests_app.tickets;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_key::text,0));
 select * into t from requests_app.tickets where request_key=p_key;
 if found then
  if t.name<>p_name or t.subject<>p_subject or t.body<>p_body then
   return jsonb_build_object('error','conflict');
  end if;
  if t.status<>'draft' then return jsonb_build_object('error','confirmed'); end if;
  if t.expires_at<now() then return jsonb_build_object('error','expired'); end if;
  return jsonb_build_object('ok',true,'expires_at',t.expires_at);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('draft-global',0));
 delete from requests_app.tickets where status='draft' and expires_at < now()-interval '1 day';
 if (select count(*) from requests_app.tickets where created_at>now()-interval '1 day')>=500
 or (select count(*) from requests_app.tickets where ip_hash=p_ip_hash and created_at>now()-interval '10 minutes')>=10
 then return jsonb_build_object('error','rate_limit'); end if;
 insert into requests_app.tickets(request_key,name,subject,body,token_hash,ip_hash)
 values(p_key,p_name,p_subject,p_body,p_hash,p_ip_hash) returning * into t;
 return jsonb_build_object('ok',true,'expires_at',t.expires_at);
end $$;

create or replace function public.nr_handle_update(p_event jsonb,p_admin bigint)
returns void language plpgsql security definer set search_path=pg_catalog,requests_app as $$
declare
 uid bigint := (p_event->>'updateId')::bigint;
 actor bigint := (p_event->>'actor')::bigint;
 chat bigint := (p_event->>'chat')::bigint;
 action text := p_event->>'action';
 ticket uuid;
 t requests_app.tickets;
 item record;
 data jsonb;
 role text;
 n integer := greatest(0,least(coalesce((p_event->>'page')::integer,0),10000));
 k text := 'u:'||(p_event->>'updateId')||':';
 is_admin boolean;
begin
 if uid is null or actor is null or actor<=0 or actor<>chat then return; end if;
 perform pg_advisory_xact_lock(uid);
 if exists(select 1 from requests_app.updates where update_id=uid) then return; end if;
 insert into requests_app.updates(update_id) values(uid);
 is_admin := p_admin is not null and actor=p_admin;
 role := case when is_admin then 'admin' else 'client' end;
 if action='id' then
  perform requests_app.queue(k||'id',chat,'text',jsonb_build_object('text','Ваш Telegram ID: '||actor));
  return;
 end if;
 if p_admin is null then
  perform requests_app.queue(k||'setup',chat,'text',jsonb_build_object('text','Приём обращений пока не подключён. Попробуйте позже.'));
  return;
 end if;
 if action='start' then
  select * into t from requests_app.tickets where token_hash=p_event->>'tokenHash' for update;
  if not found or t.status<>'draft' or t.expires_at<now() then
   perform requests_app.queue(k||'expired',chat,'text',jsonb_build_object('text','Ссылка уже использована или устарела. Свои заявки: /my. Новое обращение можно оставить на сайте.'));
   return;
  end if;
  update requests_app.tickets set status='new',client_chat_id=actor,confirmed_at=now() where id=t.id returning * into t;
  perform requests_app.queue(k||'client',chat,'card',jsonb_build_object('ticket',requests_app.ticket_json(t),'role','client','heading','Заявка принята'));
  perform requests_app.queue(k||'admin',p_admin,'card',jsonb_build_object('ticket',requests_app.ticket_json(t),'role','admin','heading','Новая заявка'));
  return;
 elsif action in ('list','mine') then
  if action='list' and not is_admin then
   perform requests_app.queue(k||'denied',chat,'text',jsonb_build_object('text','Список владельца недоступен. Ваши заявки: /my'));
   return;
  end if;
  select coalesce(jsonb_agg(requests_app.ticket_json(q)),'[]'::jsonb) into data
  from (select * from requests_app.tickets
    where status<>'draft' and (is_admin or client_chat_id=actor)
    and (coalesce(p_event->>'filter','all')='all' or status=p_event->>'filter')
    order by created_at desc,id limit 9 offset n*8) q;
  perform requests_app.queue(k||'list',chat,'list',jsonb_build_object('tickets',data,'role',role,'page',n,'filter',coalesce(p_event->>'filter','all')));
  return;
 elsif action='retry' then
  if not is_admin then return; end if;
  if coalesce(p_event->>'job','')<>'' then
   update requests_app.outbox set state='pending',leased_until=null,error_code=null
    where id=(p_event->>'job')::bigint and state='failed';
   perform requests_app.queue(k||'retry',chat,'text',jsonb_build_object('text',case when found then 'Повторная отправка поставлена в очередь.' else 'Сообщение уже отправлено или не найдено.' end));
  else
   select coalesce(jsonb_agg(q),'[]'::jsonb) into data from
    (select id,kind,error_code from requests_app.outbox where state='failed' order by id desc limit 8) q;
   perform requests_app.queue(k||'retrylist',chat,'retrylist',jsonb_build_object('jobs',data));
  end if;
  return;
 end if;
 if action='reply' then
  select ticket_id into ticket from requests_app.prompts
   where chat_id=chat and message_id=(p_event->>'replyTo')::bigint;
 else
  begin ticket := (p_event->>'ticket')::uuid; exception when invalid_text_representation then ticket:=null; end;
 end if;
 if ticket is not null then select * into t from requests_app.tickets where id=ticket for update; end if;
 if ticket is null or t.id is null or t.status='draft' or (not is_admin and t.client_chat_id<>actor) then
  perform requests_app.queue(k||'help',chat,'help',jsonb_build_object('role',role));
  return;
 end if;
 if action='view' then
  perform requests_app.queue(k||'view',chat,'card',jsonb_build_object('ticket',requests_app.ticket_json(t),'role',role,'heading','Обращение'));
 elsif action='prompt' then
  perform requests_app.queue(k||'prompt',chat,'prompt',jsonb_build_object('ticket',requests_app.ticket_json(t)));
 elsif action='reply' then
  if char_length(coalesce(p_event->>'body','')) not between 1 and 2000 then
   perform requests_app.queue(k||'length',chat,'text',jsonb_build_object('text','Нужно текстовое сообщение от 1 до 2000 символов. Нажмите «Ответить» ещё раз.'));
   return;
  end if;
  insert into requests_app.messages(ticket_id,author,body,update_id) values(t.id,role,p_event->>'body',uid);
  perform requests_app.queue(k||'forward',case when is_admin then t.client_chat_id else p_admin end,
   'forward',jsonb_build_object('ticket',requests_app.ticket_json(t),'author',role,'body',p_event->>'body'));
  perform requests_app.queue(k||'ack',chat,'text',jsonb_build_object('text','Сообщение по заявке №'||t.number||' сохранено и передаётся адресату.'));
 elsif action='status' and is_admin then
  if p_event->>'status' not in ('new','in_progress','done') then return; end if;
  update requests_app.tickets set status=p_event->>'status' where id=t.id returning * into t;
  perform requests_app.queue(k||'status-admin',chat,'card',jsonb_build_object('ticket',requests_app.ticket_json(t),'role','admin','heading','Статус изменён'));
  perform requests_app.queue(k||'status-client',t.client_chat_id,'status',jsonb_build_object('ticket',requests_app.ticket_json(t)));
 elsif action='history' then
  for item in select * from requests_app.messages where ticket_id=t.id order by id limit 5 offset n*5 loop
   perform requests_app.queue(k||'history:'||item.id,chat,'history',jsonb_build_object('number',t.number,'author',item.author,'body',item.body,'date',item.created_at));
  end loop;
  perform requests_app.queue(k||'historynav',chat,'historynav',
   jsonb_build_object('ticket',requests_app.ticket_json(t),'page',n,'more',
   (select count(*)> (n+1)*5 from requests_app.messages where ticket_id=t.id)));
 else
  perform requests_app.queue(k||'help2',chat,'help',jsonb_build_object('role',role));
 end if;
end $$;

create or replace function public.nr_claim_outbox(p_limit integer default 8)
returns jsonb language plpgsql security definer set search_path=pg_catalog,requests_app as $$
declare data jsonb;
begin
 with selected as (
  select id from requests_app.outbox where state='pending'
   or (state='processing' and leased_until<now())
  order by id for update skip locked limit greatest(1,least(p_limit,12))
 ), claimed as (
  update requests_app.outbox o set state='processing',attempts=attempts+1,
    lease_token=gen_random_uuid(),leased_until=now()+interval '90 seconds'
  from selected s where o.id=s.id returning o.*
 ) select coalesce(jsonb_agg(claimed),'[]'::jsonb) into data from claimed;
 return data;
end $$;

create or replace function public.nr_delivered(p_id bigint,p_lease uuid,p_message bigint)
returns void language plpgsql security definer set search_path=pg_catalog,requests_app as $$
declare o requests_app.outbox;
begin
 update requests_app.outbox set state='sent',sent_at=now(),leased_until=null,error_code=null
 where id=p_id and lease_token=p_lease and state='processing' returning * into o;
 if found and o.kind='prompt' then
  insert into requests_app.prompts(chat_id,message_id,ticket_id)
  values(o.chat_id,p_message,(o.data->'ticket'->>'id')::uuid) on conflict do nothing;
 end if;
end $$;

create or replace function public.nr_failed(p_id bigint,p_lease uuid,p_code text,p_admin bigint)
returns void language plpgsql security definer set search_path=pg_catalog,requests_app as $$
declare o requests_app.outbox;
begin
 update requests_app.outbox set state='failed',leased_until=null,error_code=left(p_code,60)
 where id=p_id and lease_token=p_lease and state='processing' returning * into o;
 if found and p_admin is not null and o.chat_id<>p_admin then
  perform requests_app.queue('failure:'||o.id||':'||o.attempts,p_admin,'text',
   jsonb_build_object('text','Одно сообщение не доставлено. История сохранена. Проверить и повторить: /retry'));
 end if;
end $$;

revoke all on function public.nr_create_draft(uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.nr_handle_update(jsonb,bigint) from public,anon,authenticated;
revoke all on function public.nr_claim_outbox(integer) from public,anon,authenticated;
revoke all on function public.nr_delivered(bigint,uuid,bigint) from public,anon,authenticated;
revoke all on function public.nr_failed(bigint,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.nr_create_draft(uuid,text,text,text,text,text) to service_role;
grant execute on function public.nr_handle_update(jsonb,bigint) to service_role;
grant execute on function public.nr_claim_outbox(integer) to service_role;
grant execute on function public.nr_delivered(bigint,uuid,bigint) to service_role;
grant execute on function public.nr_failed(bigint,uuid,text,bigint) to service_role;
notify pgrst, 'reload schema';
commit;

