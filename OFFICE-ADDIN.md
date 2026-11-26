# Gem.AI · Add-in do Office (Office.js)

Um **suplemento de painel de tarefas** para Word, Excel e PowerPoint que lê o
**documento aberto** com a API JavaScript do Office e pergunta à IA (Groq) pelo
mesmo proxy seguro (`gem-chat`) usado pelo chat.

> **Escolha confirmada:** usar a CDN oficial da Microsoft **somente nesta página**.
> O `index.html` do chat, os extratores de anexos e o PWA continuam **100% locais**,
> sem nenhuma CDN — a correção publicada em `8fa6e0e` não é revertida.

---

## 1. O que é e o que NÃO é

| | |
| --- | --- |
| ✅ **É** | Um Add-in que gira **dentro** do Office e lê o documento/pasta/apresentação aberta via `Word.run` / `Excel.run` / `PowerPoint.run` |
| ❌ **Não é** | Um parser de `.docx/.xlsx/.pptx` **anexados** no navegador. Isso continua sendo feito por `docs/js/extract.js` + `office-legacy.js`, 100% offline, sem CDN |
| ❌ **Não é** | Office Scripts (só Excel na Web, outro modelo) nem VBA/COM |
| ❌ **Não é** | Publicação no Marketplace: o manifesto é para **sideload/desenvolvimento** |

A documentação da Microsoft é explícita: a biblioteca deve ser referenciada pela
CDN no `<head>` e o suplemento só deve rodar sua lógica depois de `Office.onReady()`;
se a CDN for bloqueada, `onReady` **nunca resolve** [1](https://learn.microsoft.com/pt-br/office/dev/add-ins/develop/understand-the-javascript-api-for-office)
[2](https://learn.microsoft.com/pt-br/office/dev/add-ins/develop/loading-the-dom-and-runtime-environment).
Nosso `waitForOffice()` tem timeout de 12 s e mostra essa falha com clareza.

### APIs usadas (progressivo, com `isSetSupported`)

| Host | Caminho preferido | Conjunto | Fallback |
| --- | --- | --- | --- |
| Word | `context.document.body.load("text")` | `WordApi 1.1` | `body.paragraphs.load("text")` → seleção |
| Excel | `worksheets.load("items/name")` + `getUsedRange().load("values")` (até 12 planilhas, 200 linhas cada) | `ExcelApi 1.1` | seleção |
| PowerPoint | `slides.items[].shapes.items[].textFrame.textRange.load("text")` | `PowerPointApi 1.4` | seleção |
| Todos | `Office.context.document.getSelectedDataAsync(CoercionType.Text)` | Common API | — |

O texto é limitado a `CONFIG.maxExtractChars` (20.000). Em Excel, `spreadsheet.js`
também gera o resumo estatístico (soma/média/distintos) antes de enviar.
`buildContent()` acrescenta a instrução "ANALISE esse conteúdo… Não diga que não
tem acesso aos arquivos", igual ao chat. **Se nada puder ser lido, o painel avisa e
não inventa conteúdo.**

**Inserir resposta:** Word → `body.insertParagraph(..., InsertLocation.end)`;
Excel → célula selecionada; PowerPoint → use **Copiar** (a API de texto só é de
leitura aqui). O painel **não grava histórico no Supabase** nem faz upload para o
Storage: o texto do documento vai direto para a Edge Function, que já responde
com `Access-Control-Allow-Origin: *`.

---

## 2. Arquivos

```
docs/office/
├── manifest.xml        # manifesto XML (TaskPaneApp) para Word/Excel/PowerPoint
├── taskpane.html       # ÚNICA página com <script> da CDN office.js
├── taskpane.css        # UI compacta para painel de 320–420 px, alvos 44 px
├── taskpane.js         # Office.onReady, leitura por host, streaming, inserir/copiar
└── icons/
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-64.png
    └── icon-80.png
OFFICE-ADDIN.md         # este documento
```

O `taskpane.js` reutiliza `../js/config.js`, `groq.js`, `markdown.js`, `files.js`
e `spreadsheet.js`. Como o painel e o chat estão na **mesma origem**
(`https://sr-agente208.github.io/Gem.AI/`), `localStorage` é compartilhado:
modelo, system prompt e `GEM_CHAT_TOKEN` configurados em *Configurações* valem aqui.

**URLs públicas (GitHub Pages):**

- Painel: <https://sr-agente208.github.io/Gem.AI/office/taskpane.html>
- Manifesto: <https://sr-agente208.github.io/Gem.AI/office/manifest.xml>

---

## 3. Como instalar (sideload)

Requisitos: **Microsoft 365 / Office 2021+ / Office na Web** (WebView moderno com
ES modules), conta com permissão para instalar suplementos e acesso à CDN da
Microsoft. Office 2016 perpétuo usa WebView legado sem ES modules — não suportado.

### Office na Web (Word/Excel/PowerPoint no navegador) — mais simples

1. Baixe [`docs/office/manifest.xml`](https://sr-agente208.github.io/Gem.AI/office/manifest.xml)
   (ou `git clone` e use o arquivo local).
2. Abra um documento em <https://www.office.com/>.
3. **Inserir → Suplementos → Obter Suplementos → Meus Suplementos → Fazer upload do meu suplemento**.
4. Selecione o `manifest.xml` baixado.
5. Na aba **Página Inicial**, clique em **Analisar com IA** (grupo *Gem.AI*).

### Word/Excel/PowerPoint desktop (Windows/Mac)

- **Windows**: coloque `manifest.xml` numa **pasta compartilhada** de rede e
  registre-a como catálogo confiável (Arquivo → Opções → Central de Confiabilidade →
  Catálogos de Suplementos Confiáveis), ou use o *Office Add-ins Development Kit*
  / `npm` Yeoman para sideload local.
- **Mac**: `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`
  (ou a pasta `wef` do Excel/PowerPoint), copie o `manifest.xml` e reinicie o app.
- Alternativa universal: abra o **Office na Web** (passo acima) para validar
  primeiro; o desktop exige o catálogo porque não aceita `file://` direto.

### Antes do primeiro uso

1. Abra o chat normal, configure `GEM_CHAT_TOKEN` em *Configurações → Avançado*
   se você trocou o secret no Supabase, e confirme que uma resposta funciona.
2. Volte ao painel: ele usa as mesmas credenciais públicas (`apikey` + token)
   — **a `GROQ_API_KEY` continua apenas como secret da Edge Function**.

---

## 4. Uso

1. **Ler documento** (opcional) → mostra `✓ N caracteres · corpo do documento`.
2. Escreva a pergunta (Ctrl/⌘ + Enter envia).
3. **Analisar com IA** → streaming da Groq no painel (Markdown renderizado).
4. **Copiar** ou **Inserir no documento**.
5. **Abrir chat completo** para histórico, anexos e a central de suporte.

Desmarque *"Incluir o conteúdo do documento"* para uma pergunta avulsa — útil
também se o painel for aberto fora do Office (modo sem contexto).

---

## 5. Privacidade e limites

- O texto do documento **sai do Office e vai para a Groq** através do proxy;
  não é salvo no Storage e não entra no histórico do Supabase.
- Não há `service_role`, PAT do GitHub nem `GROQ_API_KEY` no navegador.
- Limite de 20.000 caracteres por leitura; planilhas: 12 abas × 200 linhas;
  slides: 60. Documentos maiores são **recortados com aviso no `docInfo`**.
- PowerPoint sem `PowerPointApi 1.4` lê **apenas a seleção** e diz isso na tela.
- `Office.onReady()` com CDN bloqueada → timeout de 12 s, badge "fora do Office"
  e painel ainda utilizável sem contexto. Não há loop infinito nem tela branca.

---

## 6. Solução de problemas

| Sintoma | Causa / ação |
| --- | --- |
| Badge "fora do Office" / "Office.js não carregou" | CDN `officeapis.public.onecdn.static.microsoft` bloqueada. O `onerror` tenta `appsforoffice.microsoft.com/lib/1/hosted/office.js`; libere uma das duas no firewall/proxy |
| Botão não aparece na faixa | Manifesto sem `VersionOverrides` ou sideload incompleto; refaça o upload e use a aba **Página Inicial** |
| "Não foi possível ler o documento" | Selecione um trecho no host e tente de novo. Em PowerPoint antigo, atualize o Office (PowerPointApi 1.4) |
| `Token de acesso inválido` (401) | Abra as Configurações do **chat** e confira `GEM_CHAT_TOKEN`; mesma origem, mesmo `localStorage` |
| `GROQ_API_KEY não configurada` | Secret da Edge Function, não do painel; veja o Passo 1 do README |
| Resposta não entra no documento | Inserção automática só em Word/Excel. No PowerPoint, use Copiar |
| Página em branco no Office 2016 | WebView legado sem ES modules; use Microsoft 365 / Office 2021+ / Office na Web |

---

## 7. Referências

- [Entender a API JavaScript do Office](https://learn.microsoft.com/pt-br/office/dev/add-ins/develop/understand-the-javascript-api-for-office)
- [Referência da API JavaScript do Office](https://learn.microsoft.com/pt-br/office/dev/add-ins/reference/javascript-api-for-office)
- [Carregar o DOM e o ambiente de runtime / `Office.onReady`](https://learn.microsoft.com/pt-br/office/dev/add-ins/develop/loading-the-dom-and-runtime-environment)
- [Especificar hosts e requisitos de API](https://learn.microsoft.com/pt-br/office/dev/add-ins/develop/specify-office-hosts-and-api-requirements)
- [Manifesto dos suplementos](https://learn.microsoft.com/pt-br/office/dev/add-ins/develop/add-in-manifests)
- [Word.Body.text](https://learn.microsoft.com/pt-br/javascript/api/word/word.interfaces.bodydata) ·
  [Excel.Worksheet](https://learn.microsoft.com/pt-br/javascript/api/excel/excel.worksheet) ·
  [PowerPoint.TextFrame](https://learn.microsoft.com/pt-br/javascript/api/powerpoint/powerpoint.textframe)
- [Office Dev Center](https://developer.microsoft.com/en-us/office?culture=pt-br&country=BR)
