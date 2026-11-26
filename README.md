# Gem.AI

Chat com IA **100% estático**, feito para **GitHub Pages**:

- **Supabase** → banco do histórico (PostgREST + RLS) **e** Storage privado dos anexos.
- **Groq** → geração das respostas, em **streaming** (SSE), com **visão** para imagens.
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
              ├──────────────────────────► /storage/v1/object/gem-uploads/...
              │                            /storage/v1/object/sign/... ← download temporário
              │
              └──────────────────────────► /functions/v1/gem-chat
                                              │  GROQ_API_KEY (Supabase Secret)
                                              ▼
                                     api.groq.com/openai/v1
                                     /chat/completions  (stream: true)
```

Cada navegador gera um UUID (`gem.owner` no `localStorage`) e o envia em `x-gem-owner`.
As políticas de RLS (banco **e** `storage.objects`) só deixam ver/inserir/apagar linhas
com aquele `owner_key`. Nenhum arquivo passa por um servidor próprio: o original vai
direto para o Storage e apenas o texto/imagem processados no navegador vão ao modelo.

---

## Estado atual (configurado nesta sessão)

| Item | Status |
| --- | --- |
| Projeto Supabase | `escola-de-jegues` · ref `jikizafsbrclkfgoccha` · região `ca-central-1` |
| Migration `gem_ai_init` | ✅ aplicada (`gem_conversations`, `gem_messages`, 7 políticas RLS, trigger) |
| Migration `gem_ai_files` | ✅ aplicada (`attachments`, `display_content`, bucket `gem-uploads`, 4 políticas de Storage) |
| Migration `gem_ai_files_limit` | ✅ aplicada (bucket com teto de 1 GiB; quem limita hoje é o plano) |
| Limite por arquivo | ✅ **1 GiB** por arquivo lógico, dividido em partes de 48 MiB (teto por objeto do Free: 50 MiB) |
| Edge Function `gem-chat` | ✅ ativa, **v10**, `verify_jwt = false`, multimodal + diagnósticos |
| `GROQ_API_KEY` | ✅ gravada como **secret** no Supabase (não está em nenhum arquivo) |
| `GEM_CHAT_TOKEN` | ✅ secret no Supabase + valor padrão no `config.js`; exigido no POST |
| Teste do banco | ✅ insert de conversa + mensagem; RLS isolou (1 linha para o dono, 0 para outro) |
| Teste da Groq | ✅ texto, visão e POST SSE reais; `?test=1` → `{"ok":true,"model":"qwen/qwen3.8-27b","reply":"OK"}` |
| Teste do Storage | ✅ upload/sign/list/delete como `anon` (200) e preflight CORS libera `x-gem-owner` |
| **GitHub Pages** | ✅ **no ar** em <https://sr-agente208.github.io/Gem.AI/> · `status: built`, branch `/docs` |

Modelos de chat disponíveis na conta e habilitados no app (verificados em 2026-11-24):
`qwen/qwen3.8-27b` **(padrão)**, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`.
Os antigos `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `llama-4-scout` e `qwen/qwen3-32b`
foram **descontinuados** pela Groq e retornam erro — por isso foram removidos da lista.

> Tentei criar um projeto Supabase novo, mas sua conta já atingiu o limite de **2 projetos free ativos**.
> Por isso as tabelas foram criadas no projeto existente, todas com prefixo `gem_` para não colidir
> com `alunos`, `turmas`, `notas` etc. O Pages foi habilitado manualmente no painel do GitHub
> (o token desta integração não tem permissão para a API de Pages) e o repositório hoje é público.

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

## Token de acesso (`GEM_CHAT_TOKEN`) — ✅ já configurado

O POST da função (o único que consome cota de verdade) exige o header `x-gem-token`.
O valor foi gerado, gravado como **secret** no Supabase e colocado como padrão em
`CONFIG.chatToken` (`docs/js/config.js`), então o chat funciona sem configuração extra.
Você pode sobrescrevê-lo em **Configurações → Avançado → Token opcional da função**.

```bash
# gerar/rotacionar
supabase secrets set GEM_CHAT_TOKEN=$(openssl rand -hex 24)
# e atualize CONFIG.chatToken em docs/js/config.js com o MESMO valor
```

> ⚠️ **Limite honesto:** como o site é público, esse token também é público (está no JS).
> Ele impede uso casual da URL por quem não abriu o app, **mas não é autenticação**.
> Para proteção real: gere um valor novo, configure-o **apenas** como secret, remova
> `CONFIG.chatToken` do `config.js` e preencha o campo em Configurações em cada navegador —
> ou migre para **Supabase Auth** + `verify_jwt = true`.

Os GETs de diagnóstico continuam abertos (não consomem cota relevante: o health check usa 64 tokens).

## Endpoints de diagnóstico da função

| Chamada | Retorno |
| --- | --- |
| `GET /functions/v1/gem-chat` | Modelos ativos que geram texto + `vision_models` |
| `GET /functions/v1/gem-chat?test=1&model=X` | Health check de texto: `{ ok, model, reply }` |
| `GET /functions/v1/gem-chat?test=1&vision=1` | Health check multimodal (PNG 32×32 em base64) |
| `GET /functions/v1/gem-chat?storage=1` | Sobe um `.txt`, gera URL assinada, lista e apaga: status de cada passo |
| `GET /functions/v1/gem-chat?sse=1` | Faz o POST do chat com e sem `x-gem-token`; valida SSE, `[DONE]` e `X-Gem-Model` |
| `GET /functions/v1/gem-chat?sse=1&vision=1` | O mesmo, com imagem: confirma a troca automática para o modelo com visão |
| `GET /functions/v1/gem-chat?cors=1` | Preflight CORS do REST e do Storage |
| `POST /functions/v1/gem-chat` | Chat completion em streaming (SSE), texto e/ou até 3 imagens |

O botão **Testar conexão** usa os dois GETs: lista os modelos habilitados e faz uma geração real.

---

## Passo 2 · GitHub Pages — ✅ já publicado

**Site ao vivo:** <https://sr-agente208.github.io/Gem.AI/>

Configuração atual (confirmada pela API do GitHub):

```json
{
  "status": "built",
  "build_type": "legacy",
  "source": { "branch": "arena/e947b2eb-gem-ai", "path": "/docs" },
  "html_url": "https://sr-agente208.github.io/Gem.AI/",
  "https_enforced": true,
  "public": true
}
```

O repositório é **público** (necessário para Pages em plano Free) e os builds do Pages já
rodaram com sucesso nesta branch. Não há GitHub Actions nem comando de build: cada
`git push origin arena/e947b2eb-gem-ai` publica `docs/` automaticamente em ~30 s.
O site usa só caminhos relativos, então funciona no subpath `/Gem.AI/`.

> Não adicionei um workflow do Actions justamente para não trocar a origem do deploy:
> `build_type: legacy` (branch + `/docs`) já está funcionando.

Não é necessário GitHub Actions nem `npm install`: não há nada para compilar.
O arquivo `docs/.nojekyll` evita que o Jekyll do Pages ignore arquivos.

---

## Passo 3 · Envio de arquivos — ✅ implementado

Clique no **clipe** ao lado do campo de mensagem, ou **arraste arquivos** para o composer.
Os anexos aparecem como chips com miniatura, tamanho e botão de remover; envie junto com
o texto (ou só os arquivos). Nas mensagens antigas, clique num anexo para abrir o original.

| Tipo | O que acontece |
| --- | --- |
| **Imagens** (PNG/JPG/WebP/GIF…) | Reduzidas no `<canvas>` para até 1024 px (mínimo 32×32, exigido pela Groq), convertidas em JPEG e enviadas ao modelo como `image_url` em base64. |
| **Texto** (`.txt`, `.md`, `.json`, `.csv`, `.py`, `.js`…) | Lido no navegador e incluído no prompt com marcadores `--- Arquivo: nome ---`. |
| **PDF** | Texto extraído no navegador com `pdfjs-dist@4` (até 20 páginas) via CDN, carregado sob demanda. PDFs digitalizados sem camada de texto ficam salvos, mas não são "lidos" — aparece um aviso. |
| **Outros** | Salvos no Storage e listados na bolha, mas o modelo recebe só um aviso de que não lê aquele formato. |

Limites (`docs/js/config.js`): **5 arquivos** por mensagem, **1 GiB por arquivo**,
**3 imagens** por requisição, **20.000 caracteres** extraídos por arquivo de texto/PDF
(arquivos acima de 50 MiB não são lidos no navegador, só salvos). O proxy também corta
em 3 imagens e 4 MB de base64 por imagem.

> **Como chegamos a 1 GiB sem pagar Pro:** o Supabase Free limita cada **objeto** a
> **50 MiB** (medido: 52.428.800 B → 200; 53.477.376 B → `413 EntityTooLarge`). O app
> então **divide** arquivos grandes em partes de 48 MiB (`storagePartBytes`), salva cada
> parte como um objeto separado no mesmo prefixo e **recompõe no download**. Um arquivo
> de 1 GiB vira 22 partes. O `file_size_limit` do bucket já é 1 GiB, e o *Global file
> size limit* do plano continua valendo para cada parte — que fica abaixo dele.
> ⚠️ O Free também tem **~1 GiB de armazenamento total**: um único arquivo de 1 GiB
> consome a cota inteira. No Pro (100 GiB) isso deixa de ser problema; com o limite
> global elevado, basta aumentar `storagePartBytes` para reduzir o número de partes.

- **Upload resumável + partes:** até 6 MB vai por `POST /object/...`; acima disso o app
  usa `POST /storage/v1/upload/resumable` (TUS 1.0.0) + `PATCH` por chunk de 6 MB.
  Não precisa de JWT: usa `apikey` + `x-gem-owner`, e o Storage expõe
  `Location`/`Upload-Offset` via CORS. O progresso (arquivo/parte/%) aparece acima do
  composer. No clique do anexo, `downloadAttachment()` gera uma URL assinada por parte,
  baixa tudo, junta num `Blob` e dispara o download com o nome original.

### Tentativa com Git / GitHub (medida, não adotada)

A pedido, testei o Git como segundo provedor para grandes arquivos:

| Teste real neste repo | Resultado |
| --- | --- |
| Arquivo em Git normal | limite **100 MiB** (25 MiB pela UI) |
| Git LFS, `objects/batch` com 1 GiB | ✅ `200` + URL de upload pré-assinada |
| Git LFS com 2 GiB | ✅ `200` + URL de upload |
| Git LFS com 5 GiB | ❌ `Size must be less than or equal to 2147483648` |
| `PUT` na URL pré-assinada | aponta para `github-cloud.s3.amazonaws.com` |

O Git LFS aceita 1–2 GB e devolve URLs pré-assinadas (o token fica no servidor e os
bytes iriam direto do browser). **Não foi adotado** porque: (1) exigiria um **token de
escrita do GitHub** como secret no Supabase — não vou mover a credencial desta sessão
para outro serviço sem autorização; (2) o repositório é **público**, então os anexos
deixariam de ser privados; (3) cada upload precisaria de um commit com o ponteiro LFS,
o que polui o histórico e dispara rebuild do Pages; (4) o `PUT` vai para um host S3
cujo CORS de browser não consegui validar neste sandbox. O Git continua sendo usado
para o que faz bem: versionar o código e publicar o site a cada `git push`.

- **Visão:** único modelo da conta que aceita imagem é `qwen/qwen3.8-27b`
  (`CONFIG.visionModel`). Ao anexar imagens, o app troca automaticamente para ele — e a
  função faz o mesmo no servidor, caso receba imagem com outro modelo. GPT-OSS não enxergam.
- **Histórico:** `gem_messages.content` guarda o prompt real (texto + transcrições),
  `display_content` guarda só o que o usuário digitou e `attachments` guarda os metadados
  (`name`, `size`, `type`, `kind`, `path` **ou** `parts[]`, e uma miniatura reduzida da imagem). Ao reabrir
  uma conversa, as miniaturas e o contexto multimodal são reconstruídos.
- **Privacidade:** bucket **`gem-uploads` é privado**. Caminho
  `<owner_key>/<conversation_id>/<uuid>-<nome>`; as 4 políticas `gem_files_*` comparam
  `(storage.foldername(name))[1]` com `gem_current_owner()`. O download usa
  `POST /storage/v1/object/sign/...` com validade de **1 hora**. Apagar uma conversa
  também tenta apagar os arquivos dela (melhor esforço).
- **Sem backend próprio:** upload, extração e redimensionamento acontecem no navegador;
  só a chamada à Groq passa pela Edge Function. A `GROQ_API_KEY` continua fora do front.

> Aviso honesto: o isolamento por `x-gem-owner` é um UUID local, não login (veja Segurança).
> Quem souber o UUID de outra pessoa poderia acessar os arquivos dela. Para produção, use
> **Supabase Auth** + `auth.uid()` nas políticas do Storage.

## Passo 4 · Rodar localmente (opcional)

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
                  role, content, display_content, attachments jsonb, created_at)
storage.buckets  ('gem-uploads', public = false, file_size_limit = 1073741824 /* 1 GiB */)
```

- `gem_current_owner()` lê `current_setting('request.headers')::json ->> 'x-gem-owner'`.
- `gem_owns_conversation(uuid)` (`security definer`) evita recursão de RLS nas políticas de mensagens.
- Trigger `gem_messages_touch` atualiza `updated_at` da conversa a cada mensagem (ordena a sidebar).
- Políticas para `anon`/`authenticated`: `SELECT`, `INSERT`, `UPDATE`, `DELETE` em conversas;
  `SELECT`, `INSERT`, `DELETE` em mensagens — sempre limitadas ao `owner_key` da requisição.
- `gem_files_select/insert/update/delete` em `storage.objects`: mesmo `owner_key`, usando
  `storage.foldername(name)[1]`. Validadas com upload, URL assinada, listagem e exclusão reais
  (HTTP 200 como `anon`, sem `service_role`).

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
- ⚠️ Com `verify_jwt = false`, o POST da função exige `GEM_CHAT_TOKEN` (secret no Supabase).
  Como o valor padrão está no `config.js` de um site público, isso é **ofuscação, não autenticação**:
  qualquer pessoa pode lê-lo no código. Para produção, use **Supabase Auth** + `verify_jwt = true`,
  mantenha o token apenas no secret/localStorage, restrinja o CORS e adicione rate limiting.
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
│       ├── config.js            # URL + publishable key + token + modelos + limites de arquivo
│       ├── db.js                # cliente PostgREST (conversas e mensagens + anexos)
│       ├── files.js             # anexos: validação, PDF, canvas, upload/URL assinada/limpeza
│       ├── groq.js              # cliente SSE da Edge Function
│       ├── markdown.js          # renderizador Markdown seguro
│       └── app.js               # UI, histórico, streaming, anexos, modal de configs
└── supabase/
    ├── config.toml
    ├── migrations/202611240001_gem_ai_init.sql
    ├── migrations/202611240002_gem_ai_files.sql
    ├── migrations/202611240003_gem_ai_files_limit.sql
    └── functions/gem-chat/index.ts
```

## Personalizações comuns

| Quero… | Onde mexer |
| --- | --- |
| Adicionar/trocar modelos | `ALLOWED_MODELS` em `supabase/functions/gem-chat/index.ts` **e** `CONFIG.models` em `docs/js/config.js` |
| Mudar o comportamento padrão | `DEFAULT_SYSTEM` na função e `defaultSystemPrompt` no `config.js` |
| Mudar cores/layout | `docs/styles.css` (variáveis no `:root`) |
| Trocar o token de acesso | `supabase secrets set GEM_CHAT_TOKEN=...` **e** `CONFIG.chatToken` em `docs/js/config.js` |
| Aceitar mais de 1 GB | Suba `CONFIG.maxFileBytes`; com Pro, aumente também `storagePartBytes` (menos partes) |
| Mudar limites de anexo | `CONFIG.maxFilesPerMessage`, `maxFileBytes`, `storagePartBytes`, `maxProcessBytes`, `maxImagesPerMessage`, `maxExtractChars`, `imageMaxEdge`, `resumableThreshold`, `uploadChunkBytes` em `docs/js/config.js` |
| Trocar o bucket | `CONFIG.storageBucket` + a migration `202611240002_gem_ai_files.sql` + `index.ts` |
| Usar outro projeto Supabase | `docs/js/config.js` ou Configurações → Avançado |

## Solução de problemas

| Sintoma | Causa provável |
| --- | --- |
| `GROQ_API_KEY não configurada` (HTTP 503) | Falta o secret — veja o Passo 1 |
| `Supabase 401/403` no histórico | `apikey` errada, ou `x-gem-owner` ausente; confira a publishable key |
| `No 'Access-Control-Allow-Origin'` | A função não foi publicada ou está com versão antiga |
| `Token de acesso inválido` (HTTP 401) | `CONFIG.chatToken` ≠ secret `GEM_CHAT_TOKEN`; confira Configurações → Avançado e dê **Ctrl+F5** (cache do JS após um deploy) |
| Sidebar vazia após trocar de navegador | É o esperado: o `owner_key` é local por navegador |
| `model_decommissioned` / modelo inválido | Use **Atualizar** no seletor e ajuste `ALLOWED_MODELS` |
| `Não foi possível salvar … no Storage` | Dono/chave divergentes ou bucket ausente: rode `?storage=1` na função e confira `CONFIG.storageBucket` |
| `413 / The object exceeded the maximum allowed size` | Uma parte ficou acima do teto do plano (50 MiB no Free). Reduza `CONFIG.storagePartBytes`; o bucket aceita 1 GiB |
| Download de arquivo grande trava | O download junta todas as partes num `Blob` em memória. Para 1 GiB isso exige ~1 GiB de RAM no navegador |
| Upload grande travou no meio | Acima de 6 MB o app usa TUS em chunks; confira `?cors=1` no diagnóstico e a conexão. O progresso aparece acima do composer |
| PDF sem texto extraído | PDF digitalizado (imagem) ou CDN do `pdfjs-dist` bloqueada; o arquivo original continua disponível para download |
| `Image must have at least 32 pixels` | Não deve ocorrer: `files.js` centraliza imagens pequenas num canvas 32×32 |
| Imagens ignoradas com GPT-OSS | Esperado: o app e o proxy trocam automaticamente para `qwen/qwen3.8-27b` |
| Anexo não abre ao clicar | Link assinado expira em 1 h; recarregue a conversa para gerar outro |
| Página 404 no Pages | Branch/folder errados, repositório privado em plano Free, ou build ainda rodando (~30 s) |
