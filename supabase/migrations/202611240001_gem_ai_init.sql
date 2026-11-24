-- Gem.AI · schema do chat
-- Prefixo gem_ para conviver com as tabelas já existentes neste projeto Supabase.
-- Isolamento por "dono" anônimo: o browser envia o header x-gem-owner (UUID local)
-- e o PostgREST o expõe via current_setting('request.headers').

create extension if not exists pgcrypto;

create table if not exists public.gem_conversations (
  id            uuid primary key default gen_random_uuid(),
  owner_key     text not null check (char_length(owner_key) between 8 and 128),
  title         text not null default 'Novo chat' check (char_length(title) <= 200),
  model         text not null default 'llama-3.3-70b-versatile',
  system_prompt text not null default 'Você é o Gem.AI, um assistente útil, direto e cordial. Responda em português do Brasil, salvo pedido contrário.',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.gem_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.gem_conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (char_length(content) <= 100000),
  created_at      timestamptz not null default now()
);

create index if not exists gem_conversations_owner_idx
  on public.gem_conversations (owner_key, updated_at desc);
create index if not exists gem_messages_conversation_idx
  on public.gem_messages (conversation_id, created_at asc);

-- Quem é o dono da requisição atual (header x-gem-owner, em minúsculas).
create or replace function public.gem_current_owner()
returns text
language sql stable
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-gem-owner', '');
$$;

-- security definer evita recursão de RLS ao checar a conversa a partir de gem_messages.
create or replace function public.gem_owns_conversation(p_conversation_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.gem_conversations c
    where c.id = p_conversation_id
      and c.owner_key = public.gem_current_owner()
  );
$$;

-- Mantém a conversa no topo da lista quando chega uma mensagem nova.
create or replace function public.gem_touch_conversation()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  update public.gem_conversations
     set updated_at = now()
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists gem_messages_touch on public.gem_messages;
create trigger gem_messages_touch
after insert on public.gem_messages
for each row execute function public.gem_touch_conversation();

alter table public.gem_conversations enable row level security;
alter table public.gem_messages     enable row level security;

drop policy if exists gem_conv_select on public.gem_conversations;
drop policy if exists gem_conv_insert on public.gem_conversations;
drop policy if exists gem_conv_update on public.gem_conversations;
drop policy if exists gem_conv_delete on public.gem_conversations;
drop policy if exists gem_msg_select  on public.gem_messages;
drop policy if exists gem_msg_insert  on public.gem_messages;
drop policy if exists gem_msg_delete  on public.gem_messages;

create policy gem_conv_select on public.gem_conversations
  for select to anon, authenticated
  using (owner_key = public.gem_current_owner());

create policy gem_conv_insert on public.gem_conversations
  for insert to anon, authenticated
  with check (owner_key = public.gem_current_owner());

create policy gem_conv_update on public.gem_conversations
  for update to anon, authenticated
  using (owner_key = public.gem_current_owner())
  with check (owner_key = public.gem_current_owner());

create policy gem_conv_delete on public.gem_conversations
  for delete to anon, authenticated
  using (owner_key = public.gem_current_owner());

create policy gem_msg_select on public.gem_messages
  for select to anon, authenticated
  using (public.gem_owns_conversation(conversation_id));

create policy gem_msg_insert on public.gem_messages
  for insert to anon, authenticated
  with check (public.gem_owns_conversation(conversation_id));

create policy gem_msg_delete on public.gem_messages
  for delete to anon, authenticated
  using (public.gem_owns_conversation(conversation_id));

revoke all on function public.gem_owns_conversation(uuid) from public;
grant execute on function public.gem_owns_conversation(uuid) to anon, authenticated;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.gem_conversations to anon, authenticated;
grant select, insert, update, delete on public.gem_messages      to anon, authenticated;

notify pgrst, 'reload schema';
