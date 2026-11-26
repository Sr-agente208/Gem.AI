-- Gem.AI · login real (Supabase Auth) SEM quebrar o modo anônimo.
-- Espelho da migration remota `gem_ai_auth` aplicada em 2026-11-26.
--
-- Ideia: owner_key continua sendo o identificador estável do navegador (nada de
-- renomear objetos no Storage, o que quebraria os anexos). Um usuário
-- autenticado pode VINCULAR um ou mais owner_keys à sua conta; a RLS passa a
-- aceitar tanto o dono local quanto qualquer dono vinculado a auth.uid().

create table if not exists public.gem_owner_links (
  user_id   uuid not null references auth.users(id) on delete cascade,
  owner_key text not null,
  linked_at timestamptz not null default now(),
  primary key (user_id, owner_key)
);
alter table public.gem_owner_links enable row level security;

drop policy if exists gem_link_select on public.gem_owner_links;
drop policy if exists gem_link_insert on public.gem_owner_links;
drop policy if exists gem_link_delete on public.gem_owner_links;
create policy gem_link_select on public.gem_owner_links
  for select to authenticated using (user_id = auth.uid());
create policy gem_link_insert on public.gem_owner_links
  for insert to authenticated with check (user_id = auth.uid());
create policy gem_link_delete on public.gem_owner_links
  for delete to authenticated using (user_id = auth.uid());
revoke all on public.gem_owner_links from anon;
grant select, insert, delete on public.gem_owner_links to authenticated;
-- O Supabase concede UPDATE/TRUNCATE/REFERENCES/TRIGGER por padrão; a tabela de
-- vínculos não precisa deles (toda escrita passa pela RPC security definer).
revoke update, truncate, references, trigger on public.gem_owner_links from authenticated;

-- Verdadeiro quando o owner_key é o dono local OU está vinculado à conta atual.
create or replace function public.gem_owner_visible(p_owner_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    p_owner_key = nullif(current_setting('request.headers', true)::json ->> 'x-gem-owner', ''),
    false
  ) or (
    auth.uid() is not null and exists (
      select 1 from public.gem_owner_links l
      where l.user_id = auth.uid() and l.owner_key = p_owner_key
    )
  );
$$;

-- Vincula o owner_key DESTA requisição (header) à conta autenticada.
-- Sem parâmetro livre: o cliente não pode escolher o owner de outra pessoa.
create or replace function public.gem_link_current_owner()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_owner text := nullif(current_setting('request.headers', true)::json ->> 'x-gem-owner', '');
begin
  if v_uid is null then
    raise exception 'Entre na sua conta para vincular este navegador.';
  end if;
  if v_owner is null or v_owner !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'Identidade local invalida.';
  end if;
  if (select count(*) from public.gem_owner_links where user_id = v_uid) >= 20 then
    raise exception 'Limite de 20 navegadores vinculados por conta.';
  end if;
  insert into public.gem_owner_links (user_id, owner_key)
  values (v_uid, v_owner) on conflict do nothing;
  return jsonb_build_object('linked', true);
end;
$$;

create or replace function public.gem_owns_conversation(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.gem_conversations c
    where c.id = p_conversation_id and public.gem_owner_visible(c.owner_key)
  );
$$;

create or replace function public.gem_owns_support_ticket(p_ticket_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.gem_support_tickets t
    where t.id = p_ticket_id and public.gem_owner_visible(t.owner_key)
  );
$$;

create or replace function public.gem_reply_support_ticket(p_ticket_id uuid, p_body text)
returns gem_support_messages language plpgsql security definer set search_path = public as $$
declare
  v_body  text := trim(coalesce(p_body, ''));
  v_msg   public.gem_support_messages;
begin
  if not exists (select 1 from public.gem_support_tickets t
                  where t.id = p_ticket_id and public.gem_owner_visible(t.owner_key)) then
    raise exception 'Chamado nao encontrado.';
  end if;
  if exists (select 1 from public.gem_support_tickets
             where id = p_ticket_id and status = 'fechado') then
    raise exception 'Este chamado esta fechado; abra um novo.';
  end if;
  if char_length(v_body) < 2 or char_length(v_body) > 5000 then
    raise exception 'Mensagem deve ter entre 2 e 5000 caracteres.';
  end if;
  if (select count(*) from public.gem_support_messages
       where ticket_id = p_ticket_id and author = 'user'
         and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Limite de 20 mensagens por hora neste chamado.';
  end if;
  insert into public.gem_support_messages (ticket_id, author, body)
  values (p_ticket_id, 'user', v_body) returning * into v_msg;
  return v_msg;
end;
$$;

create or replace function public.gem_close_support_ticket(p_ticket_id uuid)
returns gem_support_tickets language plpgsql security definer set search_path = public as $$
declare v_ticket public.gem_support_tickets;
begin
  update public.gem_support_tickets
     set status = 'fechado', updated_at = now()
   where id = p_ticket_id
     and public.gem_owner_visible(owner_key)
  returning * into v_ticket;
  if v_ticket.id is null then raise exception 'Chamado nao encontrado.'; end if;
  return v_ticket;
end;
$$;

grant execute on function public.gem_owner_visible(text) to anon, authenticated;
grant execute on function public.gem_link_current_owner() to authenticated;
grant execute on function public.gem_owns_conversation(uuid) to anon, authenticated;
grant execute on function public.gem_owns_support_ticket(uuid) to anon, authenticated;
grant execute on function public.gem_reply_support_ticket(uuid, text) to anon, authenticated;
grant execute on function public.gem_close_support_ticket(uuid) to anon, authenticated;

-- Conversas: leitura/escrita aceita dono local OU vinculado.
drop policy if exists gem_conv_select on public.gem_conversations;
drop policy if exists gem_conv_insert on public.gem_conversations;
drop policy if exists gem_conv_update on public.gem_conversations;
drop policy if exists gem_conv_delete on public.gem_conversations;
create policy gem_conv_select on public.gem_conversations
  for select to anon, authenticated using (public.gem_owner_visible(owner_key));
create policy gem_conv_insert on public.gem_conversations
  for insert to anon, authenticated with check (public.gem_owner_visible(owner_key));
create policy gem_conv_update on public.gem_conversations
  for update to anon, authenticated
  using (public.gem_owner_visible(owner_key))
  with check (public.gem_owner_visible(owner_key));
create policy gem_conv_delete on public.gem_conversations
  for delete to anon, authenticated using (public.gem_owner_visible(owner_key));

-- Mensagens usam gem_owns_conversation(), já atualizada. Nenhuma policy muda.
-- FAQ continua pública.
drop policy if exists gem_ticket_select on public.gem_support_tickets;
create policy gem_ticket_select on public.gem_support_tickets
  for select to anon, authenticated using (public.gem_owner_visible(owner_key));

-- Storage: mesma regra para a primeira pasta do path.
drop policy if exists gem_files_select on storage.objects;
drop policy if exists gem_files_insert on storage.objects;
drop policy if exists gem_files_update on storage.objects;
drop policy if exists gem_files_delete on storage.objects;
create policy gem_files_select on storage.objects
  for select to anon, authenticated using (
    bucket_id = 'gem-uploads'
    and public.gem_owner_visible((storage.foldername(name))[1])
  );
create policy gem_files_insert on storage.objects
  for insert to anon, authenticated with check (
    bucket_id = 'gem-uploads'
    and public.gem_owner_visible((storage.foldername(name))[1])
  );
create policy gem_files_update on storage.objects
  for update to anon, authenticated using (
    bucket_id = 'gem-uploads'
    and public.gem_owner_visible((storage.foldername(name))[1])
  ) with check (
    bucket_id = 'gem-uploads'
    and public.gem_owner_visible((storage.foldername(name))[1])
  );
create policy gem_files_delete on storage.objects
  for delete to anon, authenticated using (
    bucket_id = 'gem-uploads'
    and public.gem_owner_visible((storage.foldername(name))[1])
  );
