# Suporte do Gem.AI · runbook da equipe

Sistema de suporte **sem build, sem SDK e sem token de escrita no navegador**.
Dois canais complementares:

| Canal | Onde fica | Para que serve |
| --- | --- | --- |
| **Supabase (principal)** | `gem_support_faq`, `gem_support_tickets`, `gem_support_messages` | FAQ editável, chamados com protocolo/status/thread e resposta da equipe dentro do app |
| **GitHub Issues (alternativo)** | `.github/ISSUE_TEMPLATE/gem-ai-suporte.yml` + label `suporte` | Relato público, sem precisar de sessão; o app gera um link de issue **pré-preenchida** com diagnóstico |

O usuário abre **Ajuda e suporte** no menu lateral (funciona no iOS/Android/PWA).
Abas: *Ajuda* (FAQ), *Abrir chamado*, *Meus chamados*, *Diagnóstico*.

---

## 1. Schema (migration `gem_ai_support`)

Arquivo versionado: `supabase/migrations/202611260004_gem_ai_support.sql`.
Aplicada no projeto `escola-de-jegues` (`jikizafsbrclkfgoccha`) em 2026-11-26.

```
gem_support_faq        id · category · question · answer · sort_order · published
gem_support_tickets    id · owner_key · category · subject · contact · status · context · source · created_at · updated_at
gem_support_messages   id · ticket_id → tickets · author ('user'|'staff'|'system') · body · created_at
```

**Isolamento:** reutiliza `gem_current_owner()` → header `x-gem-owner` (UUID anônimo
no `localStorage`, o mesmo das conversas). RLS:

- FAQ: `SELECT` público somente onde `published = true`.
- Chamados: `SELECT` somente `owner_key = gem_current_owner()`.
- Mensagens: `SELECT` somente via `gem_owns_support_ticket(ticket_id)`.
- **Nenhuma** policy de `INSERT`/`UPDATE`/`DELETE` para `anon`: toda escrita passa por
  RPCs `security definer` que validam a identidade e os limites.

RPCs expostas ao `anon` (PostgREST `/rest/v1/rpc/...`):

| Função | Efeito |
| --- | --- |
| `gem_create_support_ticket(p_category, p_subject, p_body, p_contact, p_context)` | Cria chamado **+** primeira mensagem numa transação atômica; devolve a linha do chamado |
| `gem_reply_support_ticket(p_ticket_id, p_body)` | Acrescenta mensagem do usuário ao próprio chamado |
| `gem_close_support_ticket(p_ticket_id)` | Usuário encerra o próprio chamado |

**Status automáticos** (trigger `gem_support_messages_touch`):

```
abertura            → aberto
resposta da equipe  → respondido
nova msg do usuário → em_analise
usuário encerrou    → fechado (não muda por novas mensagens)
```

**Anti-abuso:** assunto 4–160, descrição 10–5000, diagnóstico ≤6000 caracteres,
máx. **5 chamados/hora/dono** e **20 mensagens de usuário/hora/chamado**.
Chamado fechado não aceita novas mensagens.

---

## 2. Como responder um chamado

No **Supabase Dashboard → Table Editor** (ou SQL Editor, que roda com privilégios de
serviço e ignora RLS):

```sql
-- 1) Ver chamados abertos, mais recentes primeiro
select id, owner_key, category, subject, status, created_at, context
from public.gem_support_tickets
order by updated_at desc
limit 30;

-- 2) Ler a thread de um chamado
select author, body, created_at
from public.gem_support_messages
where ticket_id = '<UUID_DO_CHAMADO>'
order by created_at asc;

-- 3) Responder: o trigger muda status para 'respondido' sozinho
insert into public.gem_support_messages (ticket_id, author, body)
values ('<UUID_DO_CHAMADO>', 'staff', 'Obrigado pelo relato! Já corrigimos...');

-- 4) Marcar em análise ou fechar manualmente, se precisar
update public.gem_support_tickets
   set status = 'em_analise', updated_at = now()
 where id = '<UUID_DO_CHAMADO>';
```

O usuário vê a resposta em **Meus chamados** ao abrir a central (ou clicar em
*Atualizar*). O protocolo exibido no app são os **8 primeiros caracteres do UUID**
sem hífens, em maiúsculas (`protocolOf()`), ex.: `1A2B3C4D`.

> Não é preciso implantar nada: a FAQ, os status e as respostas são lidos do
> Supabase em tempo real pelo app estático do GitHub Pages.

## 3. Editar a FAQ

`gem_support_faq` no Table Editor: `INSERT`/`UPDATE` normal, `published = false`
esconde o item sem apagar, `sort_order` controla a ordem. As 7 perguntas iniciais
foram semeadas pela migration (anexos, limites, iOS/Android, privacidade, suporte).

Se a FAQ estiver indisponível (offline/RLS), o app mostra automaticamente uma
**FAQ essencial embutida no HTML** — nunca deixa o usuário sem resposta.

## 4. Canal GitHub

- Template de issue: `.github/ISSUE_TEMPLATE/gem-ai-suporte.yml` (categoria, protocolo,
  relato, diagnóstico, plataforma, confirmação de dados sensíveis).
- Label `suporte` criada no repositório (`#7c6cff`).
- `.github/ISSUE_TEMPLATE/config.yml` aponta para a central no app e para este runbook.
- O botão **“Issue no GitHub”** no app monta
  `/issues/new?title=...&body=...&labels=suporte` com o protocolo e o diagnóstico
  já preenchidos — e o link de cada chamado **respeita o checkbox** de diagnóstico
  usado na abertura (contexto vazio ⇒ issue sem diagnóstico). **Nenhum token GitHub
  vai para o navegador**: o usuário confirma a abertura logado na própria conta.

Para registrar um chamado vindo de issue no banco (opcional):

```sql
insert into public.gem_support_tickets (owner_key, category, subject, source, context)
values ('github-import', 'bug', 'Relato via issue #123', 'github', '{"issue":123}'::jsonb);
```
> `owner_key = 'github-import'` é uma identidade administrativa: nenhum usuário
> anônimo a possui, então o chamado fica visível apenas para a equipe.

## 5. Diagnóstico e privacidade

`docs/js/support.js → diagnostics()` coleta **apenas**: versão do app, URL base,
user agent, plataforma, idioma, fuso, online, PWA, tela/viewport, pontos de toque,
`DecompressionStream`, suporte a MP4/H.264 e WebM, Web Share, Service Worker,
disponibilidade de `localStorage` e os últimos 5 erros de runtime (mensagem curta).

**Não coleta** nem envia: `apikey`, `chatToken`, `GROQ_API_KEY`, `owner_key`,
conteúdo/títulos das conversas ou anexos. O checkbox *“Incluir diagnóstico
técnico”* fica marcado por padrão, mostra o texto exato em *“Ver exatamente o que
será enviado”* e pode ser desmarcado.

## 6. Fila offline

Se o envio falhar por rede (`status = 0` ou 5xx), o chamado vai para
`localStorage["gem.support.outbox"]` e aparece em **Meus chamados** como
`RASCUNHO` (com botão *Descartar rascunho*). O reenvio é automático ao:

- abrir a central de ajuda;
- clicar em *Atualizar*;
- o evento `online` disparar.

Erros 4xx (validação, limite de abuso) **não** entram na fila: são descartados e
exibidos ao usuário, porque não se resolvem sozinhos.

## 7. Solução de problemas

| Sintoma | Causa / ação |
| --- | --- |
| `404 Could not find the function public.gem_create_support_ticket` | Cache do PostgREST. Rode `notify pgrst, 'reload schema';` e confira `grant execute ... to anon` |
| `42501 permission denied` nas RPCs | Conferir `revoke all ... from public` + `grant execute ... to anon, authenticated` e o `security definer` |
| `Meus chamados` vazio após limpar dados do site | Esperado: nova identidade `x-gem-owner` → RLS mostra só os chamados dela |
| FAQ não carrega | Verificar policy `gem_faq_select` e `published = true`; o app cai na FAQ embutida |
| Limite de 5 chamados/hora | Anti-abuso intencional da RPC; ajuste o intervalo na migration se o projeto crescer |
| Link de issue abre sem label | Confirmar que a label `suporte` existe no repositório |

## 8. Arquivos

```
.github/ISSUE_TEMPLATE/gem-ai-suporte.yml   # formulário de issue
.github/ISSUE_TEMPLATE/config.yml           # links de contato
SUPORTE.md                                  # este runbook
supabase/migrations/202611260004_gem_ai_support.sql
docs/js/support.js                          # REST, RPCs, fila offline, diagnóstico, link Git
docs/js/support-ui.js                       # abas, FAQ, formulário, thread, status
docs/index.html                             # botão no menu + modal da central
docs/styles.css                             # estilos touch-friendly (44px)
```
