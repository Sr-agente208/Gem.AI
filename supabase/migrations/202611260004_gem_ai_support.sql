-- Gem.AI · sistema de suporte: FAQ pública + chamados com thread
-- Aplicada remotamente via connector (migration `gem_ai_support`).
-- Isolamento pelo mesmo header x-gem-owner das conversas. O usuário anônimo
-- só LÊ os próprios chamados; escritas passam por RPCs security definer que
-- validam identidade, tamanhos e limites de abuso.

create extension if not exists pgcrypto;

create table if not exists public.gem_support_faq (
  id          uuid primary key default gen_random_uuid(),
  category    text not null default 'geral',
  question    text not null check (char_length(question) between 5 and 240),
  answer      text not null check (char_length(answer) between 5 and 4000),
  sort_order  integer not null default 0,
  published   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.gem_support_tickets (
  id          uuid primary key default gen_random_uuid(),
  owner_key   text not null check (char_length(owner_key) between 8 and 128),
  category    text not null default 'duvida'
                check (category in ('bug','duvida','sugestao','anexo','outro')),
  subject     text not null check (char_length(subject) between 4 and 160),
  contact     text check (contact is null or char_length(contact) <= 200),
  status      text not null default 'aberto'
                check (status in ('aberto','em_analise','respondido','fechado')),
  context     jsonb not null default '{}'::jsonb,
  source      text not null default 'app' check (source in ('app','github','email')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.gem_support_messages (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references public.gem_support_tickets(id) on delete cascade,
  author      text not null check (author in ('user','staff','system')),
  body        text not null check (char_length(body) between 1 and 5000),
  created_at  timestamptz not null default now()
);

create index if not exists gem_support_tickets_owner_idx
  on public.gem_support_tickets (owner_key, updated_at desc);
create index if not exists gem_support_messages_ticket_idx
  on public.gem_support_messages (ticket_id, created_at asc);
create unique index if not exists gem_support_faq_question_idx
  on public.gem_support_faq (question);

-- Dono da requisição (idempotente: mesma função da migration gem_ai_init).
create or replace function public.gem_current_owner()
returns text language sql stable
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-gem-owner', '');
$$;

create or replace function public.gem_owns_support_ticket(p_ticket_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.gem_support_tickets t
    where t.id = p_ticket_id and t.owner_key = public.gem_current_owner()
  );
$$;

-- Uma resposta da equipe marca 'respondido'; uma nova mensagem do usuário
-- reabre como 'em_analise'. A 1ª mensagem (abertura) mantém 'aberto'.
create or replace function public.gem_support_message_touch()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  update public.gem_support_tickets t
     set updated_at = now(),
         status = case
           when t.status = 'fechado' then 'fechado'
           when (select count(*) from public.gem_support_messages m where m.ticket_id = t.id) <= 1
             then t.status
           when new.author = 'staff' then 'respondido'
           else 'em_analise'
         end
   where t.id = new.ticket_id;
  return new;
end;
$$;

drop trigger if exists gem_support_messages_touch on public.gem_support_messages;
create trigger gem_support_messages_touch
after insert on public.gem_support_messages
for each row execute function public.gem_support_message_touch();

-- RPC: abre chamado + primeira mensagem numa única transação atômica.
create or replace function public.gem_create_support_ticket(
  p_category text,
  p_subject  text,
  p_body     text,
  p_contact  text default null,
  p_context  jsonb default '{}'::jsonb
) returns public.gem_support_tickets
language plpgsql security definer set search_path = public
as $$
declare
  v_owner   text := public.gem_current_owner();
  v_subject text := trim(coalesce(p_subject, ''));
  v_body    text := trim(coalesce(p_body, ''));
  v_ticket  public.gem_support_tickets;
begin
  if v_owner is null then
    raise exception 'Identidade local ausente (header x-gem-owner).';
  end if;
  if char_length(v_subject) < 4 or char_length(v_subject) > 160 then
    raise exception 'Assunto deve ter entre 4 e 160 caracteres.';
  end if;
  if char_length(v_body) < 10 or char_length(v_body) > 5000 then
    raise exception 'Descricao deve ter entre 10 e 5000 caracteres.';
  end if;
  if p_context is not null and length(p_context::text) > 6000 then
    raise exception 'Diagnostico tecnico muito grande.';
  end if;
  if (select count(*) from public.gem_support_tickets
       where owner_key = v_owner and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Limite de 5 chamados por hora. Aguarde um pouco e tente de novo.';
  end if;

  insert into public.gem_support_tickets (owner_key, category, subject, contact, context)
  values (
    v_owner,
    coalesce(nullif(p_category, ''), 'duvida'),
    v_subject,
    nullif(trim(coalesce(p_contact, '')), ''),
    coalesce(p_context, '{}'::jsonb)
  )
  returning * into v_ticket;

  insert into public.gem_support_messages (ticket_id, author, body)
  values (v_ticket.id, 'user', v_body);

  return v_ticket;
end;
$$;

-- RPC: usuário acrescenta uma mensagem ao próprio chamado.
create or replace function public.gem_reply_support_ticket(
  p_ticket_id uuid,
  p_body      text
) returns public.gem_support_messages
language plpgsql security definer set search_path = public
as $$
declare
  v_owner text := public.gem_current_owner();
  v_body  text := trim(coalesce(p_body, ''));
  v_msg   public.gem_support_messages;
begin
  if v_owner is null then raise exception 'Identidade local ausente.'; end if;
  if not exists (select 1 from public.gem_support_tickets
                  where id = p_ticket_id and owner_key = v_owner) then
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
  values (p_ticket_id, 'user', v_body)
  returning * into v_msg;
  return v_msg;
end;
$$;

-- RPC: usuário pode encerrar o próprio chamado.
create or replace function public.gem_close_support_ticket(p_ticket_id uuid)
returns public.gem_support_tickets
language plpgsql security definer set search_path = public
as $$
declare
  v_owner  text := public.gem_current_owner();
  v_ticket public.gem_support_tickets;
begin
  if v_owner is null then raise exception 'Identidade local ausente.'; end if;
  update public.gem_support_tickets
     set status = 'fechado', updated_at = now()
   where id = p_ticket_id and owner_key = v_owner
  returning * into v_ticket;
  if v_ticket.id is null then raise exception 'Chamado nao encontrado.'; end if;
  return v_ticket;
end;
$$;

alter table public.gem_support_faq      enable row level security;
alter table public.gem_support_tickets  enable row level security;
alter table public.gem_support_messages enable row level security;

drop policy if exists gem_faq_select on public.gem_support_faq;
drop policy if exists gem_ticket_select on public.gem_support_tickets;
drop policy if exists gem_ticket_msg_select on public.gem_support_messages;

create policy gem_faq_select on public.gem_support_faq
  for select to anon, authenticated using (published);
create policy gem_ticket_select on public.gem_support_tickets
  for select to anon, authenticated using (owner_key = public.gem_current_owner());
create policy gem_ticket_msg_select on public.gem_support_messages
  for select to anon, authenticated using (public.gem_owns_support_ticket(ticket_id));

-- Sem políticas de INSERT/UPDATE/DELETE para anon: toda escrita passa por RPC.
revoke insert, update, delete on public.gem_support_faq, public.gem_support_tickets,
  public.gem_support_messages from anon, authenticated;
revoke all on function public.gem_owns_support_ticket(uuid) from public;
revoke all on function public.gem_create_support_ticket(text,text,text,text,jsonb) from public;
revoke all on function public.gem_reply_support_ticket(uuid,text) from public;
revoke all on function public.gem_close_support_ticket(uuid) from public;

grant usage on schema public to anon, authenticated;
grant select on public.gem_support_faq, public.gem_support_tickets,
  public.gem_support_messages to anon, authenticated;
grant execute on function public.gem_owns_support_ticket(uuid) to anon, authenticated;
grant execute on function public.gem_create_support_ticket(text,text,text,text,jsonb) to anon, authenticated;
grant execute on function public.gem_reply_support_ticket(uuid,text) to anon, authenticated;
grant execute on function public.gem_close_support_ticket(uuid) to anon, authenticated;

-- Base de conhecimento inicial (editável pelo painel do Supabase).
insert into public.gem_support_faq (category, question, answer, sort_order) values
  ('anexos', 'O clipe não abre a galeria no celular', 'Abra o app pelo Safari (iOS) ou Chrome (Android) e toque no clipe. O seletor usa um label nativo ligado ao input de arquivo — não usamos input escondido. Se estiver dentro de um WebView de rede social, abra no navegador do sistema.', 10),
  ('anexos', 'O modelo diz que não tem acesso ao arquivo', 'Confira o chip do anexo: ele deve mostrar ✓ N caracteres lidos. Se aparecer ⚠ sem leitura, o formato não foi extraído (PDF digitalizado, arquivo criptografado ou navegador antigo). Envie um PNG/JPG da página ou salve como TXT/CSV.', 20),
  ('anexos', 'Quais formatos de Office e vídeo são analisados?', 'PDF com texto, Word/Excel/PowerPoint (OOXML e 97-2003), ODF, RTF, .msg, TXT/CSV, fotos e 3 fotogramas de vídeos MP4/WebM. Vídeo é amostragem visual: sem áudio nem movimento. MKV/AVI e codecs não decodificados geram aviso no chip.', 30),
  ('limites', 'Qual o tamanho máximo de um anexo?', '1 GiB por arquivo lógico, dividido em partes de 48 MiB no Storage (o plano Free aceita até 50 MiB por objeto). PDFs/Office acima de 50 MiB não são lidos no navegador, apenas salvos. Fotos e fotogramas dividem o limite de 3 imagens por mensagem.', 40),
  ('celular', 'Como instalar no iOS e no Android?', 'Android Chrome: menu ⋮ → Instalar aplicativo. iOS Safari 15.4+: Compartilhar → Adicionar à Tela de Início. O app usa manifest.webmanifest, ícones maskable e um service worker network-only.', 50),
  ('privacidade', 'Onde ficam minhas conversas e anexos?', 'No Supabase (PostgREST + Storage privado), isoladas por uma identidade anônima local (x-gem-owner). A chave da Groq fica apenas como segredo da Edge Function. Limpar dados do navegador gera nova identidade e o histórico anterior deixa de aparecer.', 60),
  ('suporte', 'Como acompanhar um chamado?', 'Em Ajuda e suporte → Meus chamados. Cada chamado tem um protocolo, status e thread de mensagens. Você recebe a resposta da equipe ali mesmo; também pode copiar o protocolo ou abrir uma issue no GitHub.', 70)
on conflict (question) do nothing;

notify pgrst, 'reload schema';
