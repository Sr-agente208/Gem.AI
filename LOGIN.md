# Gem.AI · Login, contas e e-mails personalizados

Tela de **Entrar / Criar conta / Recuperar senha / Minha conta** na sidebar, com
**login real no Supabase Auth** (e-mail + senha) e **botões sociais Google/GitHub**.
O **modo anônimo continua funcionando**: sem conta, o app se comporta exatamente
como antes (`apikey` + `x-gem-owner`), sem exigir cadastro de ninguém.

> Zero SDK, zero CDN, zero build: o cliente `docs/js/auth.js` fala com o GoTrue
> por REST (`/auth/v1/*`) usando `fetch`. A `GROQ_API_KEY` continua sendo apenas
> secret da Edge Function; nenhuma senha ou chave privada aparece no front.

---

## 1. Para o usuário

1. No menu lateral, toque em **Entrar / Criar conta** (cartão com ✦).
2. **Criar conta**: nome, e-mail, senha (mín. 6) e confirmação. O nome vai para
   `user_metadata.full_name` e é usado nos e-mails (`{{ .Data.full_name }}`).
3. **Entrar**: e-mail + senha. Ao entrar, o navegador é vinculado à conta e o
   histórico é recarregado automaticamente.
4. **Minha conta**: mostra nome, e-mail, método de login, botões
   **Vincular este navegador** e **Sair da conta**.
5. **Esqueci a senha**: envia link; ao voltar pelo link o modal abre em
   **Definir nova senha** (`type=recovery`).

Entrar em outro dispositivo com a mesma conta e vincular o navegador faz o
histórico, os anexos e os chamados de suporte aparecerem lá também.

---

## 2. O que foi configurado no Supabase (por API, já aplicado)

| Item | Valor |
| --- | --- |
| `external_email_enabled` | `true` (e-mail + senha) |
| `disable_signup` | `false` (cadastro aberto) |
| `site_url` | `https://sr-agente208.github.io/Gem.AI/` |
| `uri_allow_list` | `https://sr-agente208.github.io/Gem.AI/**`, `.../office/**`, `https://*.e2b.app/**`, `http://localhost:5173/**` |
| `mailer_autoconfirm` | **`true`** |
| `jwt_exp` | `3600` s, com refresh automático a cada 45 s no front |
| `security_refresh_token_rotation_enabled` | `true`, reuse interval `10` s |

### ⚠️ Por que `mailer_autoconfirm = true`

O plano Free usa o mailer padrão do Supabase, com **limite de ~2 e-mails/hora**
e nenhum SMTP configurado (`smtp_host` está vazio). Com confirmação obrigatória,
o primeiro cadastro travaria até o e-mail chegar — e testes repetidos seriam
bloqueados. Auto-confirm deixa o login **funcionar imediatamente**.

Consequência: qualquer pessoa pode criar conta com qualquer e-mail, e **o e-mail
de confirmação não é enviado** (os templates de confirmação só passam a valer
quando você desligar o auto-confirm). A **recuperação de senha continua enviando
e-mail** e usa o template personalizado.

**Para produção:** configure um SMTP próprio em *Project Settings → Auth → SMTP*,
desmarque *Auto-confirm new users* e aplique os templates abaixo. Assim a
confirmação de e-mail volta a ser obrigatória. Isso é uma decisão de segurança
deliberada e facilmente reversível no painel.

---

## 3. E-mails personalizados (prontos para colar)

O conector do Supabase expõe a **leitura** dos templates (`get_auth_config`), mas
**não expõe a escrita** deles. Portanto os arquivos precisam ser colados **uma
vez** em *Authentication → Email Templates*:

| Arquivo | Campo no painel |
| --- | --- |
| `supabase/email-templates/confirmacao.html` | Confirm signup |
| `supabase/email-templates/recuperacao.html` | Reset Password |
| `supabase/email-templates/magic-link.html` | Magic Link |
| `supabase/email-templates/email-alterado.html` | Change Email Address |
| `supabase/email-templates/assuntos.md` | Todos os campos de **Subject** |

São HTML inline, PT-BR, com a marca Gem.AI (✦, gradiente `#7c6cff → #5b8cff`,
fundo escuro), botão de 44 px e link literal para fallback. Variáveis usadas:
`{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .OldEmail }}`, `{{ .NewEmail }}`,
`{{ .Data.full_name }}`. O nome cadastrado aparece no "Olá, …".

---

## 4. Login social (Google / GitHub) — **requer 1 passo no painel**

Os botões e o fluxo OAuth já estão implementados (`startOAuth()` →
`/auth/v1/authorize?provider=...&redirect_to=...`, retorno lido do fragmento
`#access_token=...` em `consumeRedirect()`).

Mas `get_auth_config` confirmou que **nenhum provedor está habilitado** e não há
`client_id`/`secret`. O conector não tem ferramenta para cadastrar essas
credenciais — e eu não vou inventar chaves. Para ativar:

1. **Google Cloud Console** → crie um *OAuth client ID* (Web application).
   - *Authorized redirect URI*: `https://jikizafsbrclkfgoccha.supabase.co/auth/v1/callback`
2. **GitHub** → *Settings → Developer settings → OAuth Apps → New OAuth App*.
   - *Authorization callback URL*: a mesma URL acima.
3. No Supabase: *Authentication → Providers → Google / GitHub* → cole
   **Client ID** e **Client Secret**, marque *Enabled*, salve.
4. Recarregue o app: os botões passam a funcionar sem nenhuma mudança de código.

As URLs de retorno já estão no `uri_allow_list`. Se o provedor não estiver
habilitado, o GoTrue devolve `?error=...` e o modal mostra a mensagem traduzida
em vez de ficar mudo.

**Nota técnica:** o fluxo usado é o **implícito** (tokens no fragmento), porque o
app é 100% estático e não usa a `supabase-js` (que guarda o `code_verifier` do
PKCE). Se o projeto estiver forçando PKCE, o retorno vem `?code=...` e o modal
avisa para usar e-mail/senha. Para PKCE sem SDK seria preciso um pequeno
exchange server — fora do escopo "zero build".

---

## 5. Como a RLS liga conta ↔ histórico (sem perder anexos)

Migration `gem_ai_auth` (espelho: `supabase/migrations/202611260005_gem_ai_auth.sql`):

- **`gem_owner_links(user_id → auth.users, owner_key)`** — um usuário pode
  vincular até **20 navegadores**. RLS: só vê/cria/apaga os próprios vínculos.
- **`gem_link_current_owner()`** — RPC `security definer`, sem parâmetro livre:
  lê `x-gem-owner` do header e exige `auth.uid()`. Limite de 20 vínculos e
  validação do formato do owner_key. Chamada automaticamente no login/cadastro
  e pelo botão "Vincular este navegador".
- **`gem_owner_visible(owner_key)`** — `true` se o owner for o dono local **ou**
  estiver vinculado à conta autenticada.
- Substitui `gem_current_owner()` nas policies de `gem_conversations`,
  `gem_support_tickets` e nas 4 policies de `storage.objects`; as funções
  `gem_owns_conversation()` / `gem_owns_support_ticket()` e as RPCs de responder
  / encerrar chamado também passam a usar `gem_owner_visible()`.

**Por que não trocamos o `owner_key` pelo `user_id`:** os arquivos no Storage
estão em pastas `<owner_key>/<conversation_id>/…`. Renomear pastas por SQL não
move o objeto físico e quebraria os downloads de 1 GiB por partes, TUS e as
URLs assinadas. Mantendo o owner_key estável, **nenhum anexo é perdido** e o
login só amplia o conjunto de owners visíveis.

Quando há sessão, `db.js`, `files.js` e `support.js` acrescentam
`Authorization: Bearer <access_token>`; o PostgREST passa a rodar como
`authenticated` e `auth.uid()` funciona. `groq.js` **não** envia esse header:
a Function `gem-chat` continua com `verify_jwt=false` e `x-gem-token`, sem
alteração (v10 intacta).

---

## 6. Limitações honestas

- **Sem conta = sem criptografia de identidade.** O `x-gem-owner` é um UUID no
  `localStorage`; quem tem acesso ao navegador vê as conversas locais mesmo sem
  login. O login melhora a portabilidade entre dispositivos, não transforma o
  app em cofre.
- **`owner_key` é um segredo portável.** Quem souber o UUID de outro navegador
  poderia vinculá-lo à própria conta. Ele nunca é exibido nem enviado a terceiros,
  mas não é prova criptográfica de posse. Para produção, troque o vínculo por
  confirmação por e-mail ou por um nonce assinado.
- **Sessão no `localStorage`** (igual à `supabase-js`). XSS nesta origem a leria;
  o app escapa todo HTML renderizado e não carrega scripts de terceiros no chat.
- **Templates e provedores sociais** exigem o painel (o conector não expõe
  escrita). Está tudo documentado acima, sem segredo inventado.
- **Amostragem de vídeo** não mudou: o print com `"⚠ ver aviso"` é o aviso
  honesto de codec não suportado no navegador, não falha do login.

---

## 7. Solução de problemas

| Sintoma | Causa / ação |
| --- | --- |
| "E-mail ou senha incorretos" | Confira o e-mail; use **Esqueci a senha**. |
| "Este e-mail já tem uma conta" | Entre ou recupere a senha. |
| Link de recuperação não chega | Plano Free: ~2 e-mails/hora, sem SMTP. Configure SMTP próprio. |
| Botão Google/GitHub dá erro | Provedor não habilitado — veja a seção 4. |
| "O login social voltou em modo PKCE" | Use e-mail/senha; PKCE sem SDK exige exchange server. |
| Login social abre e volta com erro no preview do Arena | O provedor pode bloquear OAuth dentro de iframe (`X-Frame-Options`/cookies `SameSite`). Abra o **GitHub Pages em uma aba própria** para testar Google/GitHub. |
| Histórico sumiu depois de entrar | O `gem_link_current_owner()` pode ter falhado (rede). Abra **Minha conta → Vincular este navegador**. |
| Conversas continuam no outro dispositivo | Entre com a **mesma conta** e vincule aquele navegador. |
| "Sua sessão expirou" | O refresh roda a cada 45 s; se o token ficou inválido, entre de novo. |

---

## 8. Arquivos

```
docs/js/auth.js           # GoTrue REST: signIn/signUp/signOut/recover/OAuth/refresh
docs/js/auth-ui.js        # modal de login, abas, cartão de conta, vínculo
docs/index.html           # #accountBtn + #loginModal
docs/styles.css           # .account-card / .auth-* + correção dos botões
docs/js/{db,files,support}.js  # Authorization: Bearer quando autenticado
docs/js/config.js         # getAuthUrl()
supabase/migrations/202611260005_gem_ai_auth.sql
supabase/email-templates/ # 4 HTML + assuntos.md
LOGIN.md                  # este documento
```
