# Gem.AI

Chat com IA **100% estático**, feito para **GitHub Pages**:

- **Supabase** → banco do histórico de conversas (PostgREST + RLS).
- **Groq** → geração das respostas, em **streaming** (SSE).
- **Edge Function `gem-chat`** → proxy entre o navegador e a Groq, guardando a `GROQ_API_KEY` como segredo.
- **Zero build, zero dependências**: HTML + CSS + JavaScript ES modules puros em `docs/`.

> Por que o proxy? O GitHub Pages serve apenas arquivos estáticos. Se a chave da Groq fosse para o
> front-end (`.env`, `VITE_…`, `localStorage`), qualquer visitante poderia copiá-la e gastar sua cota —
> além de possíveis bloqueios de CORS. Aqui a chave **nunca sai do Supabase**.

---

## Arquitetura

```
┌────────────────────────────┐
│  GitHub Pages · docs/      │  index.html + styles.css + js/*.js
│  (navegador do usuário)    │
└─────────────┬──────────────┘
              │ apikey (publishable) + header x-gem-owner
              ├──────────────────────────► /rest/v1/gem_conversations
              │                            /rest/v1/gem_messages      ← histórico (RLS)
              │
              └──────────────────────────► /functions/v1/gem-chat
                                              │  GROQ_API_KEY (Supabase Secret)
                                              ▼
                                     api.groq.com/openai/v1
                                     /chat/completions  (stream: true)
```

Cada navegador gera um UUID (`gem.owner` no `localStorage`) e o envia em `x-gem-owner`.
As políticas de RLS só deixam ver/inserir/apagar linhas com aquele `owner_key`.

---

## Estado atual (configurado nesta sessão)

| Item | Status |
| --- | --- |
| Projeto Supabase | `escola-de-jegues` · ref `jikizafsbrclkfgoccha` · região `ca-central-1` |
| Migration `gem_ai_init` | ✅ aplicada (`gem_conversations`, `gem_messages`, 7 políticas RLS, trigger) |
| Edge Function `gem-chat` | ✅ ativa, **v4**, `verify_jwt = false` |
| `GROQ_API_KEY` | ✅ gravada como **secret** no Supabase (não está em nenhum arquivo) |
| Teste do banco | ✅ insert de conversa + mensagem; RLS isolou (1 linha para o dono, 0 para outro) |
| Teste da Groq | ✅ `GET ?test=1` gerou uma resposta real: `{"ok":true,"model":"qwen/qwen3.8-27b","reply":"OK"}` |
| **GitHub Pages** | ⏳ **falta habilitar no painel do GitHub** (passo 2) |

Modelos de chat disponíveis na conta e habilitados no app (verificados em 2026-11-24):
`qwen/qwen3.8-27b` **(padrão)**, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`.
Os antigos `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `llama-4-scout` e `qwen/qwen3-32b`
foram **descontinuados** pela Groq e retornam erro — por isso foram removidos da lista.

> Tentei criar um projeto Supabase novo, mas sua conta já atingiu o limite de **2 projetos free ativos**.
> Por isso as tabelas foram criadas no projeto existente, todas com prefixo `gem_` para não colidir
> com `alunos`, `turmas`, `notas` etc. Também tentei habilitar o Pages pela API, mas o token desta
> integração não tem permissão (`403 Resource not accessible by integration`) — é um passo manual de 30 s.

---

## Passo 1 · Chave da Groq — ✅ já configurada

A `GROQ_API_KEY` já foi gravada como **secret** do projeto (via conector Supabase) e validada com
uma geração real. Ela **não** está em `.env`, em `docs/` ou no Git.

Para trocar/rotacionar a chave (recomendado se ela ficou exposta em algum lugar):

```bash
supabase link --project-ref jikizafsbrclkfgoccha
supabase secrets set GROQ_API_KEY=gsk_nova_chave
```

Ou pelo painel: **Project Settings → Edge Functions → Secrets → GROQ_API_KEY**.
Não é preciso republicar a função depois de trocar um secret.

Opcional (recomendado se o site for público): defina também `GEM_CHAT_TOKEN` e coloque o mesmo
valor em **Configurações → Avançado → Token opcional da função**. A função passa a exigir o header
`x-gem-token`, reduzindo o risco de terceiros usarem sua cota da Groq.

### Endpoints de diagnóstico da função

| Chamada | Retorno |
| --- | --- |
| `GET /functions/v1/gem-chat` | Lista compacta só com modelos ativos que geram texto (`total` + `data[].id`) |
| `GET /functions/v1/gem-chat?test=1&model=X` | Health check: gera alguns tokens e devolve `{ ok, model, reply }` |
| `POST /functions/v1/gem-chat` | Chat completion em streaming (SSE) |

O botão **Testar conexão** usa os dois GETs: lista os modelos habilitados e faz uma geração real.

---

## Passo 2 · Publicar no GitHub Pages

O site está em `docs/` e usa apenas caminhos relativos, então funciona tanto na raiz quanto em
`https://<usuario>.github.io/<repo>/`.

1. Faça push desta branch (necessário para o Pages enxergá-la):

   ```bash
   git push origin arena/e947b2eb-gem-ai
   ```

2. No GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**
   - **Branch:** `arena/e947b2eb-gem-ai`
   - **Folder:** `/docs`
   - **Save**

3. URL esperada: <https://sr-agente208.github.io/Gem.AI/>

> ⚠️ **Atenção:** este repositório está **privado**. Em contas GitHub **Free**, o Pages só publica
> repositórios públicos (Pages em repo privado exige Pro/Team/Enterprise). Se o seu plano for Free,
> torne o repositório público em *Settings → General → Danger Zone → Change visibility*, ou publique
> a mesma pasta `docs/` no Cloudflare Pages / Netlify (funciona com repo privado, sem build).

Não é necessário GitHub Actions nem `npm install`: não há nada para compilar.
O arquivo `docs/.nojekyll` evita que o Jekyll do Pages ignore arquivos.

---

## Passo 3 · Rodar localmente (opcional)

```bash
python3 -m http.server 5173 --directory docs
# abra http://localhost:5173
```

Qualquer servidor estático serve (`npx serve docs`, VS Code Live Server…).
Use a tela **Configurações** para escolher modelo, system prompt, criatividade e limite de tokens,
e para testar a conexão com Supabase + Groq.

---

## Banco de dados

```sql
gem_conversations (id, owner_key, title, model, system_prompt, created_at, updated_at)
gem_messages     (id, conversation_id → gem_conversations ON DELETE CASCADE,
                  role, content, created_at)
```

- `gem_current_owner()` lê `current_setting('request.headers')::json ->> 'x-gem-owner'`.
- `gem_owns_conversation(uuid)` (`security definer`) evita recursão de RLS nas políticas de mensagens.
- Trigger `gem_messages_touch` atualiza `updated_at` da conversa a cada mensagem (ordena a sidebar).
- Políticas para `anon`/`authenticated`: `SELECT`, `INSERT`, `UPDATE`, `DELETE` em conversas;
  `SELECT`, `INSERT`, `DELETE` em mensagens — sempre limitadas ao `owner_key` da requisição.

Para reaplicar do zero em outro projeto:

```bash
supabase db push                          # aplica supabase/migrations/*.sql
supabase functions deploy gem-chat        # publica supabase/functions/gem-chat/index.ts
```

Depois ajuste `supabaseUrl` / `supabasePublishableKey` em `docs/js/config.js`
(ou direto na tela de Configurações, sem editar código).

---

## Segurança — leia antes de abrir para o público

- ✅ A `sb_publishable_…` **é pública por design** e está no código; quem protege os dados é o RLS.
  Ela vai **somente** no header `apikey` — chaves `sb_` não funcionam em `Authorization: Bearer`,
  pois a plataforma tenta decodificá-las como JWT.
- ✅ `GROQ_API_KEY` e `sb_secret_…` nunca aparecem no repositório nem no navegador.
- ⚠️ O `owner_key` é um UUID local, **não é autenticação**. Quem abrir o site ganha o próprio
  histórico; ninguém vê o de outro UUID, mas também não há login, recuperação entre dispositivos
  ou proteção contra alguém que roube esse UUID. Para produção, troque por **Supabase Auth**
  (`auth.uid()` nas políticas) e `verify_jwt = true` na função.
- ⚠️ Com `verify_jwt = false`, qualquer pessoa com a URL da função pode consumir sua cota da Groq.
  Use `GEM_CHAT_TOKEN`, restrinja CORS em `supabase/functions/gem-chat/index.ts` e/ou adicione
  rate limiting antes de divulgar o link.
- ✅ Todo Markdown renderizado passa por escape de HTML antes de qualquer substituição (sem XSS).

---

## Estrutura de arquivos

```
.
├── README.md
├── .env.example                 # referência de variáveis (nada de segredo aqui)
├── .gitignore
├── docs/                        # ← raiz publicada pelo GitHub Pages
│   ├── .nojekyll
│   ├── index.html
│   ├── styles.css
│   └── js/
│       ├── config.js            # URL + publishable key + modelos + settings locais
│       ├── db.js                # cliente PostgREST (conversas e mensagens)
│       ├── groq.js              # cliente SSE da Edge Function
│       ├── markdown.js          # renderizador Markdown seguro
│       └── app.js               # UI, histórico, streaming, modal de configs
└── supabase/
    ├── config.toml
    ├── migrations/202611240001_gem_ai_init.sql
    └── functions/gem-chat/index.ts
```

## Personalizações comuns

| Quero… | Onde mexer |
| --- | --- |
| Adicionar/trocar modelos | `ALLOWED_MODELS` em `supabase/functions/gem-chat/index.ts` **e** `CONFIG.models` em `docs/js/config.js` |
| Mudar o comportamento padrão | `DEFAULT_SYSTEM` na função e `defaultSystemPrompt` no `config.js` |
| Mudar cores/layout | `docs/styles.css` (variáveis no `:root`) |
| Usar outro projeto Supabase | `docs/js/config.js` ou Configurações → Avançado |

## Solução de problemas

| Sintoma | Causa provável |
| --- | --- |
| `GROQ_API_KEY não configurada` (HTTP 503) | Falta o secret — veja o Passo 1 |
| `Supabase 401/403` no histórico | `apikey` errada, ou `x-gem-owner` ausente; confira a publishable key |
| `No 'Access-Control-Allow-Origin'` | A função não foi publicada ou está com versão antiga |
| Sidebar vazia após trocar de navegador | É o esperado: o `owner_key` é local por navegador |
| `model_decommissioned` / modelo inválido | Use **Atualizar** no seletor e ajuste `ALLOWED_MODELS` |
| Página 404 no Pages | Branch/folder errados, ou repositório privado em plano Free |
