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
              ├──────────────────────────► /rest/v1/gem_support_*    ← FAQ + chamados (RLS)
              │                            /rest/v1/rpc/gem_*_support_ticket
              ├──────────────────────────► /storage/v1/object/gem-uploads/...
              │                            /storage/v1/object/sign/... ← download temporário
              ├──────────────────────────► GitHub Issues (issue pré-preenchida)
              │
              ├── Office (Word/Excel/PPT) ► docs/office/taskpane.html + office.js (CDN)
              │                            └──────────► /functions/v1/gem-chat
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
| Migration `gem_ai_support` | ✅ aplicada (FAQ + chamados + mensagens, 3 políticas RLS, 3 RPCs, trigger de status) |
| **Add-in do Office** | ✅ painel de tarefas Word/Excel/PowerPoint + manifesto XML + sideload documentado |
| **Login / contas** | ✅ tela Entrar · Criar conta · Recuperar senha · Minha conta (Supabase Auth) + botões Google/GitHub e e-mails personalizados |
| **Botões no mobile** | ✅ backdrop do menu não intercepta mais toques; um clique fecha o menu **e** aciona o botão |
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
| **Fotos** (PNG/JPG/WebP/GIF/HEIC…) | Reduzidas no `<canvas>` para até 1024 px (mínimo 32×32, exigido pela Groq), convertidas em JPEG e enviadas ao modelo de visão como `image_url`. As dimensões originais são informadas no prompt e o app troca automaticamente para `qwen/qwen3.8-27b`. |
| **Vídeos** (`.mp4` `.mov` `.m4v` `.webm` `.3gp` …) | **Amostragem de 3 fotogramas** (10%, 50%, 90% da duração) via `<video>` + `<canvas>`, sem ffmpeg e sem servidor. Duração, resolução e o instante de cada frame vão no prompt; os JPEGs vão como `image_url`. |
| **Planilhas** (`.csv` `.tsv` `.xlsx` `.xls` `.xlsm` `.xlsb` `.ods` …) | Células em tabulação **+ resumo estatístico automático**: tipo de cada coluna, soma, média, mínimo, máximo, valores distintos e mais frequentes — calculados no navegador antes de enviar, para a IA não chutar totais. |
| **Texto** (`.txt`, `.md`, `.json`, `.py`, `.js`, `.xml`, `.sql`…) | Lido no navegador e incluído no prompt com marcadores `--- Arquivo: nome ---`. |
| **PDF** | Texto extraído **localmente** em `docs/js/extract.js`: infla streams `FlateDecode` com `DecompressionStream` e lê os operadores `Tj`/`TJ` dentro de `BT…ET`. Sem CDN, sem worker, sem dependência. |
| **Word** — `.docx` `.docm` `.dotx` `.dotm` `.doc` `.rtf` | `word/document.xml` + cabeçalhos, rodapés, notas e comentários; `.doc` pela piece table (`CLX`/`PlcPcd`); RTF por `\uN`/`\'xx`. |
| **Excel** — `.xlsx` `.xlsm` `.xltx` `.xltm` `.xlsb` `.xls` `.ods` | Planilhas com nome e colunas em tabulação, `sharedStrings.xml`, fórmulas e números; `.xls` por BIFF8 (`SST`, `LABELSST`, `RK`, `MULRK`); `.xlsb` por varredura UTF-16LE. |
| **PowerPoint** — `.pptx` `.pptm` `.potx` `.ppsx` `.ppt` `.odp` | Slides em ordem numérica (`slide2` antes de `slide10`), `<a:t>` e notas; `.ppt` pelos atoms `TextCharsAtom`/`TextBytesAtom`, sem os textos-modelo do slide master. |
| **Outros** — `.odt` `.odg` `.odf` `.msg` e ZIPs XML | `.msg` lê assunto/de/para/corpo; qualquer ZIP com XML passa por um extrator genérico. |

#### Análise de vídeo, fotos e planilhas

**Vídeo** — não existe ffmpeg nem transcodificação: o app cria um *blob URL* (sem
carregar 1 GiB em memória), abre num `<video>`, lê `duration`/`videoWidth`/`videoHeight`
e busca 3 instantes com `currentTime`, desenhando cada um num `<canvas>` de até 768 px.
O prompt deixa explícito ao modelo que são **amostras**, não o vídeo completo, e
proíbe afirmar cenas/áudio que não aparecem nos fotogramas. `docs/js/media.js`.

> ⚠️ **Limite honesto:** é análise **visual por amostragem** — sem áudio, sem
> transcrição, sem movimento contínuo e sem OCR de legendas. Codecs que o navegador
> não decodifica (MKV, AVI, H.265 em alguns Androids, vídeos protegidos) geram
> **aviso claro no chip** em vez de erro; converta para MP4/H.264 ou envie capturas
> PNG/JPG. Fotos e fotogramas **compartilham o teto de 3 imagens** da Groq: 1 foto +
> 1 vídeo = 2 frames amostrados. O primeiro frame fica salvo no histórico para
> perguntas de follow-up.

**Fotos** — além do envio ao modelo de visão, agora o prompt recebe as dimensões
originais e uma instrução direta de análise visual ("descreva, leia textos/números
visíveis, identifique objetos"). HEIC sem decodificador e imagens abaixo de 32×32
continuam tratadas sem quebrar a requisição.

**Planilhas** — `docs/js/spreadsheet.js` calcula localmente, a partir do texto
tabulado, um `[Resumo automático da planilha]` com cabeçalho (só quando a primeira
linha realmente é um cabeçalho), contagem de linhas/colunas, colunas numéricas com
soma/média/mín/máx, colunas de texto com valores distintos e mais frequentes, e
células vazias. Aceita `1.234,56` (BR), `1,234.56` (US), `R$` e `%`. Quando não há
coluna numérica, o resumo **não inventa totais** e instrui o modelo a não inventar.

#### Formatos legados (OLE2)

`.doc`, `.xls`, `.ppt` e `.msg` são *Compound Files* (MS-CFB): um sistema de arquivos
com FAT, mini-FAT e diretório de streams dentro do próprio arquivo.
`docs/js/office-legacy.js` implementa esse leitor e os parsers de cada stream
(`WordDocument` + `0Table`/`1Table`, `Workbook`, `PowerPoint Document`, `__substg1.0_*`).
Tudo local, sem biblioteca e sem rede.

> **Validação com arquivos reais:** os parsers foram testados contra fixtures do
> **Apache POI** (`SampleDoc.doc/.docx`, `SampleSS.xls/.xlsx/.ods`, `Simple.xlsb`,
> `SampleShow.ppt/.pptx`, `.docm`/`.xlsm`/`.pptm`, `.msg`) e do **xlrd** (`ragged.xls`),
> incluindo os `.txt` de referência do POI. 17 formatos lidos, 0 avisos.

O prompt ganha **instruções explícitas de análise** — uma para o conteúdo textual
("ANALISE esse conteúdo… Não diga que não tem acesso aos arquivos"), outra para o
conteúdo visual ("descreva, leia textos e números visíveis, identifique objetos") e
uma ordem de **não inventar** quando algo não pôde ser lido. O chip mostra
`✓ N caracteres lidos`, `✓ N fotogramas`, `✓ estatísticas` ou `⚠ ver aviso`, e um
toast avisa na hora — antes, a falha só aparecia como nota invisível dentro do prompt.

> **Correção (análise de anexos):** a versão anterior importava `pdfjs-dist@4` de
> `cdn.jsdelivr.net`. O `pdf.worker.mjs` é cross-origin e falha em vários navegadores
> móveis; além disso DOCX/XLSX/PPTX viravam "o modelo não lê este formato". Reproduzido
> em teste: só `.txt` chegava ao modelo. Agora **PDF, todos os formatos Word/Excel/
> PowerPoint (novos e 97-2003), OpenDocument, RTF, `.msg` e TXT/CSV são lidos sem
> nenhuma requisição externa**. PDF digitalizado (só imagem) continua sem camada de
> texto — nesse caso envie uma foto/PNG da página para usar a visão do modelo.

Limites (`docs/js/config.js`): **5 arquivos** por mensagem, **1 GiB por arquivo**,
**3 imagens** por requisição — **fotos e fotogramas de vídeo dividem esse teto** —,
**20.000 caracteres** extraídos por arquivo (arquivos acima de 50 MiB não são lidos no
navegador, só salvos; **vídeos são exceção**, pois usam `createObjectURL` sem carregar
o arquivo inteiro). Vídeo: `videoFrameCount: 3`, `videoFrameMaxEdge: 768`,
`videoTimeoutMs: 12000`. O `buildContent()` reparte o teto de 60 mil caracteres entre
os anexos para nenhum ser cortado em silêncio. O proxy também corta em 3 imagens e
4 MB de base64 por imagem.

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

### Compatibilidade mobile — iOS e Android ✅

O app é estático, sem build, e roda nos dois sistemas — inclusive **instalado como
aplicativo**. Abaixo: a análise do bug do anexo, a matriz de plataformas e as
decisões específicas de cada sistema.

#### Análise do bug "não consigo anexar no celular"

O botão de anexar não abria a galeria, principalmente no iOS Safari. Causas e correções:

| Causa | Correção |
| --- | --- |
| `<input type="file" hidden>` + `.click()` por JS | Substituído por **`<label for="fileInput">`** e input invisível (`opacity:0`, 1×1px, **sem `display:none` nem `pointer-events:none`**). O label abre o seletor nativo sem depender de JS — validado com jsdom (clique no label dispara o input). |
| Alvo de toque de 34 px | **44×44 px** no clipe, enviar e parar; **40 px** no "remover anexo"; chips clicáveis com 44 px de altura |
| `textarea` com 15 px → iOS dá zoom ao focar e empurra o composer | `input, select, textarea { font-size: 16px }` no mobile |
| `height: 100vh` fica sob a barra de endereço do Safari | `100dvh` (com fallback `100vh`) em `body`, `.chat`, `.sidebar` e no modal |
| Botão de apagar conversa só aparecia no `:hover` | `@media (hover: none)` deixa `.conv-delete` sempre visível com 36 px |
| Home indicator / notch / Dynamic Island | `viewport-fit=cover` + `env(safe-area-inset-bottom)` no composer/toast e `env(safe-area-inset-top)` no header |
| Pull-to-refresh ao rolar o histórico | `overscroll-behavior: none` no `body` e `contain` nas listas |
| Hovers "presos" e delay de 300 ms | `touch-action: manipulation`, `-webkit-tap-highlight-color: transparent`, `-webkit-overflow-scrolling: touch` |
| Texto do hint falava em "arrastar" | Em telas de toque: "Toque no clipe para anexar · toque em enviar…" |
| Fotos de iPhone (`.heic`/`.heif`) | Reconhecidas como imagem; se o navegador não decodificar, viram anexo comum com aviso em vez de quebrar a visão |

O `<label>` mantém suporte a teclado (Enter/Espaço) e `aria-disabled` enquanto um arquivo
é processado. Não há dependência nova: continua HTML/CSS/JS puros.

#### Matriz de suporte

| Plataforma | Navegador | Seletor de arquivos | Teclado virtual | Instalação | Download |
| --- | --- | --- | --- | --- | --- |
| **iOS 15.4+** | Safari | ✅ Fototeca / Câmera / Arquivos | `visualViewport` → `.keyboard-open` | "Adicionar à Tela de Início" (`standalone`) | Web Share → "Salvar em Arquivos" ou `<a download>` |
| iOS 15.4+ | Chrome / Firefox (WebKit) | ✅ mesma engine | ✅ mesma correção | atalho via Safari | ✅ |
| **Android 8+** | Chrome 108+ | ✅ galeria / câmera / arquivos | `interactive-widget=resizes-content` | **"Instalar aplicativo"** (PWA) | Web Share nativa ou `<a download>` |
| Android | Samsung Internet / Edge | ✅ | ✅ | atalho / PWA | ✅ |
| iOS / Android | WebViews in-app (WhatsApp, Instagram…) | ⚠️ depende do app host | ⚠️ | ❌ | fallback `window.open(objectUrl)` |
| Desktop | Chrome / Firefox / Safari / Edge | ✅ + drag & drop | n/a | n/a | `<a download>` |

#### O que muda em cada sistema

**iOS Safari** — o teclado **não redimensiona** o layout viewport: ele sobrepõe a tela e
o `100dvh` permanece com a altura cheia, escondendo o composer. `setupMobilePlatform()`
em `app.js` monitora `window.visualViewport`, calcula a área visível e publica
`--app-height` + a classe `.keyboard-open` no `<html>` **somente enquanto há sobreposição**.
`env(safe-area-inset-top)` no header evita que o notch/Dynamic Island cubra o título em
modo standalone. O `apple-touch-icon` e `apple-mobile-web-app-capable` vêm do `<head>`.

**Android Chrome** — `interactive-widget=resizes-content` no `<meta viewport>` faz o
próprio `100dvh` encolher quando o teclado abre, então `--app-height` nunca é ativado:
cada plataforma usa o mecanismo que realmente suporta. O `manifest.webmanifest` +
`sw.js` habilitam o prompt "Instalar aplicativo"; os ícones 192/512 px são `maskable`
para se adaptarem ao formato do launcher.

**Ambos** — `manifest.webmanifest`, `theme-color`, `color-scheme: dark`, ícones PNG e
`display: standalone`. O `sw.js` é **network-only, sem cache e sem offline**: ele existe
apenas para satisfazer o critério de instalabilidade do Chrome. Como o app depende de
Supabase + Groq e o Pages é republicado a cada commit, cachear HTML/JS deixaria o
front dessincronizado da Edge Function.

#### Decisões deliberadas

- **Sem `capture`** no input: `capture="camera"` abriria só a câmera e **removeria a
  galeria** no iOS — exatamente o oposto do que se quer aqui.
- **Sem `accept`** restritivo: `accept="image/*"` impediria PDF e texto. Sem ele, o
  sistema oferece Fototeca, Câmera e Arquivos conforme a plataforma.
- **Sem service worker de cache / modo offline**: justificativa acima.
- **HEIC/HEIF**: o Safari costuma converter via `<canvas>` para JPEG; Chrome e WebViews
  não. Nesse caso o arquivo vai normalmente para o Storage/download, mas não entra no
  array multimodal da Groq (evita base64 inválido e não gasta uma das 3 vagas de visão).
- **Web Share API** (`navigator.share({files})`) é tentada antes do `<a download>` em
  arquivos ≤ 50 MiB e somente enquanto `navigator.userActivation.isActive` é válido;
  se o usuário cancelar ou o sistema recusar, cai no download clássico.
- Limites de 1 GiB por arquivo lógico, partes de 48 MiB e TUS **não mudaram** — continuar
  funcionando no celular foi critério de aceitação, sem regredir o desktop.

#### Como instalar e testar no celular

- **iOS**: abra https://sr-agente208.github.io/Gem.AI/ no **Safari** → Compartilhar →
  *Adicionar à Tela de Início*. (No Chrome iOS o item não aparece; é limitação da Apple.)
- **Android**: abra no **Chrome** → menu ⋮ → *Instalar aplicativo* / *Adicionar à tela inicial*.
- Dê um **Ctrl+Shift+R / limpe o cache** ou use `?cb=mobile2` na primeira visita após um deploy.

Checklist rápido:

1. Toque no clipe → aparece Fototeca / Tirar foto / Procurar (iOS) ou Galeria / Câmera / Arquivos (Android).
2. Escolha 1 imagem → chip com miniatura, nome e "✕" aparece acima do composer.
3. Abra o teclado → o composer continua visível acima dele, sem zoom na página.
4. Envie → progresso, resposta e chip clicável para baixar na bolha da mensagem.
5. Gire a tela / abra a sidebar / apague uma conversa → alvos continuam alcançáveis.

> **Validação honesta:** o sandbox não tem navegador headless nem dispositivo físico.
> Foram validados o wiring do DOM com jsdom (19/19), `node --check` nos 6 módulos, os
> 44 IDs do HTML, o MD5 dos arquivos servidos no preview e o deploy no Pages. O toque
> real na galeria, o prompt de instalação e o Web Share dependem de teste no aparelho.

---

## Ajuda e suporte — central de chamados ✅

O menu lateral ganhou **Ajuda e suporte**. Usa **Supabase** como backend principal
(chamados persistidos, FAQ editável e respostas da equipe) e **Git/GitHub** como
canal alternativo (issue pré-preenchida + template), sem token de escrita no
navegador.

| Aba | O que faz |
| --- | --- |
| **Ajuda** | FAQ vinda de `gem_support_faq` (editável no painel, sem deploy). Se o banco estiver offline, mostra uma FAQ essencial embutida no HTML |
| **Abrir chamado** | Categoria, assunto, descrição, contato opcional e diagnóstico técnico (com checkbox e prévia exata do que será enviado). Cria protocolo de 8 caracteres |
| **Meus chamados** | Protocolo, status (`aberto` → `em_analise` → `respondido` → `fechado`), thread com respostas da equipe, campo para acrescentar informação, encerrar, copiar protocolo ou abrir issue no GitHub |
| **Diagnóstico** | Versão, navegador, plataforma, codecs de vídeo, `DecompressionStream`, PWA e últimos erros de runtime — **sem tokens, chaves ou conteúdo das conversas** |

**Fluxo de dados:** `docs/js/support.js` chama `/rest/v1/rpc/gem_create_support_ticket`
(transação atômica: chamado + 1ª mensagem), `/rpc/gem_reply_support_ticket` e
`/rpc/gem_close_support_ticket`. RLS usa o mesmo `x-gem-owner` das conversas;
**não há policy de escrita para `anon`** — toda escrita passa por RPCs
`security definer` com validação e anti-abuso (5 chamados/hora, 20 mensagens/hora).
Um trigger muda o status quando a equipe responde ou o usuário reabre o chamado.

**Git / GitHub:** `.github/ISSUE_TEMPLATE/gem-ai-suporte.yml` + label `suporte`
+ `config.yml` com links de contato. O app monta
`/issues/new?title=...&body=...&labels=suporte` com protocolo e diagnóstico; o
usuário confirma a abertura logado na própria conta do GitHub.

**Offline:** se o envio falhar por rede, o chamado fica em
`localStorage["gem.support.outbox"]`, aparece como `RASCUNHO` em *Meus chamados* e
é reenviado automaticamente ao abrir a central, clicar em *Atualizar* ou voltar a
ficar online. Erros 4xx de validação não entram na fila.

Runbook completo para quem responde os chamados (SQL de resposta, edição da FAQ,
status, troubleshooting): **[SUPORTE.md](SUPORTE.md)**.

---

---

## Login e contas ✅

 Tela de **Entrar / Criar conta / Esqueci a senha / Minha conta** no cartão da
 sidebar, com **Supabase Auth real** (e-mail + senha) e botões **Google/GitHub**.
 Guia completo: **[LOGIN.md](LOGIN.md)**.

| | |
| --- | --- |
| **Modo anônimo** | Continua igual: sem conta, `apikey` + `x-gem-owner`, nenhum cadastro exigido |
| **Com conta** | `Authorization: Bearer <JWT>` no REST/Storage → RLS por `auth.uid()`; histórico, anexos e chamados aparecem em outros dispositivos |
| **Vínculo** | `gem_owner_links` + RPC `gem_link_current_owner()`; o `owner_key` do navegador **não muda**, então nenhum anexo/TUS/URL assinada quebra |
| **E-mails** | Templates PT-BR prontos em `supabase/email-templates/` (assuntos + 4 HTML com `{{ .Data.full_name }}`), para colar em Authentication → Email Templates |
| **Zero dependências** | GoTrue via REST em `docs/js/auth.js`; sem supabase-js, sem CDN, sem build. Function `gem-chat` v10 intacta |

> Config já aplicada por API: `site_url` = Pages, `uri_allow_list` com Pages +
> `*.e2b.app`, `mailer_autoconfirm=true` (plano Free tem ~2 e-mails/hora e sem
> SMTP — assim o login funciona na hora). Para produção, configure SMTP e
> desligue o auto-confirm; **recuperação de senha já envia e-mail**.
> **Login social** exige habilitar Google/GitHub no painel (Client ID/Secret) —
> o conector não expõe essa escrita e nenhuma credencial foi inventada.

---

## Add-in do Office (Office.js) ✅

 Um suplemento de **painel de tarefas** lê o **documento aberto** no Word, Excel
 ou PowerPoint e analisa com a Groq pelo mesmo proxy. Documentação completa:
 **[OFFICE-ADDIN.md](OFFICE-ADDIN.md)**.

> ⚠️ **Diferença importante:** a API JavaScript do Office **não lê `.docx/.xlsx`
> anexados no navegador**. Ela só existe dentro de um Add-in, com manifesto,
> `Office.onReady()` e a biblioteca `office.js` da CDN oficial da Microsoft.
> Os arquivos anexados continuam sendo extraídos **100% localmente** por
> `extract.js` / `office-legacy.js` — sem CDN, sem worker, sem dependências.

| Host | Leitura | Fallback |
| --- | --- | --- |
| Word | `body.load("text")` · `WordApi 1.1` | parágrafos → seleção |
| Excel | planilhas usadas + `getUsedRange().load("values")` · `ExcelApi 1.1` | seleção |
| PowerPoint | `textFrame.textRange.load("text")` · `PowerPointApi 1.4` | seleção |

- `docs/office/taskpane.html` é a **única** página com CDN (`office.js`); o
  `index.html` do chat segue 100% local. Há `onerror` para a CDN clássica e timeout
  de 12 s com aviso honesto se a Microsoft estiver bloqueada.
- `docs/office/manifest.xml`: `TaskPaneApp`, 3 hosts (`Document`/`Workbook`/
  `Presentation`), botão *Analisar com IA* na aba Página Inicial, ícones 16/32/80.
- Reutiliza `groq.js`, `buildContent()`, `renderMarkdown()` e `spreadsheet.js`;
  `localStorage` é compartilhado com o chat (mesma origem), então modelo/token já
  configurados valem no painel.
- **Inserir resposta** no fim do Word ou na célula selecionada do Excel; Copiar nos
  demais. O painel não grava histórico nem faz upload para o Storage.
- URLs: [painel](https://sr-agente208.github.io/Gem.AI/office/taskpane.html) ·
  [manifesto](https://sr-agente208.github.io/Gem.AI/office/manifest.xml).
- Sideload: Office na Web → *Inserir → Suplementos → Fazer upload do meu
  suplemento*. Desktop exige catálogo de pasta compartilhada (detalhes no doc).

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
gem_support_faq       (id, category, question, answer, sort_order, published)
gem_support_tickets   (id, owner_key, category, subject, contact, status, context, source)
gem_support_messages  (id, ticket_id → gem_support_tickets CASCADE, author, body, created_at)
```

- `gem_current_owner()` lê `current_setting('request.headers')::json ->> 'x-gem-owner'`.
- `gem_owns_conversation(uuid)` (`security definer`) evita recursão de RLS nas políticas de mensagens.
- Trigger `gem_messages_touch` atualiza `updated_at` da conversa a cada mensagem (ordena a sidebar).
- Políticas para `anon`/`authenticated`: `SELECT`, `INSERT`, `UPDATE`, `DELETE` em conversas;
  `SELECT`, `INSERT`, `DELETE` em mensagens — sempre limitadas ao `owner_key` da requisição.
- `gem_ai_support`: FAQ pública (somente `published`), chamados e mensagens isolados por
  `owner_key`; escritas exclusivamente por `gem_create_support_ticket`,
  `gem_reply_support_ticket` e `gem_close_support_ticket`. Detalhes em `SUPORTE.md`.
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
├── LOGIN.md                    # login, templates de e-mail, OAuth, RLS, limites
├── OFFICE-ADDIN.md             # Add-in do Office: APIs, manifesto, sideload, limites
├── SUPORTE.md
├── supabase/email-templates/   # assuntos.md + 4 HTML PT-BR prontos para colar                   # runbook da equipe de suporte (SQL de resposta, status, FAQ)
├── .github/ISSUE_TEMPLATE/      # formulário de issue + links de contato
├── .env.example                 # referência de variáveis (nada de segredo aqui)
├── .gitignore
├── docs/                        # ← raiz publicada pelo GitHub Pages
│   ├── .nojekyll
│   ├── index.html               # viewport/PWA/Apple meta tags + composer (<label for>)
│   ├── styles.css               # UI, toque 44px, 100dvh, safe-area, teclado iOS
│   ├── manifest.webmanifest     # PWA instalável no Android / Tela de Início no iOS
│   ├── sw.js                    # service worker network-only (critério de instalação)
│   ├── icons/
│   │   ├── icon-192.png         # apple-touch-icon + PWA 192px (maskable)
│   │   └── icon-512.png         # PWA 512px (maskable)
│   ├── office/                  # suplemento do Office (única página com CDN)
│   │   ├── manifest.xml         # TaskPaneApp · Word/Excel/PowerPoint
│   │   ├── taskpane.html        # <script> office.js da CDN oficial
│   │   ├── taskpane.css
│   │   ├── taskpane.js
│   │   └── icons/               # icon-16/32/64/80.png exigidos pelo manifesto
│   └── js/
│       ├── auth.js             # GoTrue REST (sem SDK): sessão, refresh, OAuth
│       ├── auth-ui.js          # modal de login + cartão de conta
│       ├── config.js            # URL + publishable key + token + modelos + limites de arquivo
│       ├── db.js                # cliente PostgREST (conversas e mensagens + anexos)
│       ├── extract.js           # PDF + OOXML/ODF: infla, ZIP, XML — 100% local
│       ├── office-legacy.js     # OLE2/CFB: doc/xls/ppt/msg + RTF (sem biblioteca)
│       ├── media.js             # vídeo: amostragem de frames via <video> + <canvas>
│       ├── spreadsheet.js       # estatísticas de planilhas (soma, média, distintos)
│       ├── files.js             # anexos: validação, canvas, TUS, partes, Web Share, prompt
│       ├── groq.js              # cliente SSE da Edge Function
│       ├── markdown.js          # renderizador Markdown seguro
│       ├── support.js           # REST/RPC de chamados, fila offline, diagnóstico, link Git
│       ├── support-ui.js        # abas, FAQ, formulário, thread, status
│       └── app.js               # UI, streaming, anexos, visualViewport/iOS, modais
└── supabase/
    ├── config.toml
    ├── migrations/202611240001_gem_ai_init.sql
    ├── migrations/202611240002_gem_ai_files.sql
    ├── migrations/202611240003_gem_ai_files_limit.sql
    ├── migrations/202611260004_gem_ai_support.sql
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
| PDF sem texto extraído | PDF digitalizado (só imagem) ou com fonte/CMaps proprietários: o extrator local não acha `Tj`/`TJ`. Envie uma foto/PNG da página para análise visual; o original continua disponível para download |
| DOCX/XLSX/Office "sem leitura" | Arquivo criptografado, ZIP com método de compressão não suportado, ou navegador sem `DecompressionStream` (anteriores a Chrome 103 / Safari 16.4). Salve como `.txt`/`.csv` ou atualize o navegador |
| `.doc`/`.xls`/`.ppt` parcial | Formatos OLE2 são "melhor esforço": não interpreta macros, OLE embutido, criptografia nem Word 6/95 incomum. O texto principal é extraído; confira o contador `✓ N caracteres lidos` no chip |
| `.xlsb` só traz as strings | O formato binário do Excel guarda valores/fórmulas em records `Brt*`; a varredura UTF-16LE recupera os textos, mas não a grade de células |
| Vídeo sem análise / "⚠ ver aviso" | Codec não decodificado pelo navegador (MKV, AVI, H.265 em alguns Androids), arquivo protegido ou tempo esgotado (12 s). Converta para **MP4/H.264** ou envie capturas PNG/JPG; o arquivo original continua no Storage |
| Vídeo trouxe menos de 3 frames | Fotos e frames compartilham o limite de **3 imagens** da Groq: com 1 foto anexada, o vídeo amostra 2; com 2 fotos, apenas 1 |
| Planilha sem resumo estatístico | O extrator só gera estatísticas quando há ≥2 linhas tabulares. Planilhas com apenas textos soltos ou 1 linha não entram no resumo (o conteúdo bruto ainda é enviado) |
| Resumo da planilha com rótulos errados | Só a **primeira** linha é considerada cabeçalho, e apenas se as linhas seguintes forem majoritariamente numéricas. Sem cabeçalho, as colunas são numeradas — nunca rotulamos dados como nomes de coluna |
| `Image must have at least 32 pixels` | Não deve ocorrer: `files.js` centraliza imagens pequenas num canvas 32×32 |
| Imagens ignoradas com GPT-OSS | Esperado: o app e o proxy trocam automaticamente para `qwen/qwen3.8-27b` |
| Anexo não abre ao clicar | Link assinado expira em 1 h; recarregue a conversa para gerar outro |
| `404 Could not find the function ... gem_create_support_ticket` | Cache do PostgREST após a migration: rode `notify pgrst, 'reload schema';` e confira os `grant execute` |
| FAQ/chamados não aparecem na central | Migration `gem_ai_support` não aplicada ou `x-gem-owner` ausente. A FAQ essencial embutida continua funcionando |
| Chamado virou `RASCUNHO` | Envio falhou por rede: fica no `localStorage` e é reenviado sozinho ao voltar online. Erros 4xx aparecem como toast |
| Add-in mostra "Office.js não carregou" | CDN da Microsoft bloqueada por firewall/proxy/extensão; `Office.onReady()` nunca resolve. O `onerror` tenta a CDN clássica e o timeout de 12 s avisa. O chat continua 100% local |
| Add-in não lê o PowerPoint inteiro | `PowerPointApi 1.4` ausente nessa versão: o painel usa só a seleção e avisa. Atualize o Office ou selecione as formas |
| `Token de acesso inválido` no painel | Configure `GEM_CHAT_TOKEN` nas Configurações do **chat** (mesma origem, mesmo `localStorage`) |
| Botões do chat não respondem no celular com o menu aberto | Corrigido: o backdrop do menu agora tem `pointer-events:none` e o fechamento é por delegação, sem bloquear o clique |
| Botões Google/GitHub dão erro | Provedor não habilitado no Supabase → Authentication → Providers (veja [LOGIN.md](LOGIN.md)) |
| Histórico sumiu ao entrar | Abra **Minha conta → Vincular este navegador**; o `owner_key` local não é alterado |
| Página 404 no Pages | Branch/folder errados, repositório privado em plano Free, ou build ainda rodando (~30 s) |
