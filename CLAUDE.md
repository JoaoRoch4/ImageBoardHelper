# Image Board Helper

Userscript companheiro do [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry), voltado para celular.

**A regra que define o projeto:** este script nunca modifica o Masonry. Ele roda ao lado e conversa por superfícies públicas — eventos de teclado, cliques em botões do DOM e `localStorage`. O Masonry roda dentro de uma IIFE, então suas funções internas (`showNextPost`, `zoomInImg`, `handlePostDetail`) e seu estado (`store.imageList`, `settings`) são inalcançáveis de fora. Qualquer solução proposta tem que respeitar isso.

O repositório é em inglês: código, comentários, README.md e CHANGELOG. O `README.pt-BR.md` é a tradução, e este arquivo fica em português porque é instrução de trabalho, não documentação do projeto. Fale português comigo.

---

## Restrições invioláveis

Cada uma tem um motivo concreto. Não mude sem entender o custo.

**`@grant none`.** A interceptação de `window.Fancybox` e a sobrescrita de `navigator.userAgent` exigem o mesmo realm da página. Qualquer `@grant` coloca o script num sandbox onde `window` não é o `window` da página e as duas coisas param de funcionar em silêncio. É por isso que as opções vivem no painel e não em `GM_registerMenuCommand`. O `@inject-into page` explicita a mesma escolha: o padrão `auto` do Violentmonkey cai no sandbox quando o CSP do site bloqueia scripts de página, e aí as duas coisas quebram do mesmo jeito.

**`@noframes` e `@downloadURL`.** Sem o primeiro, o script roda dentro de iframes e o painel pode montar lá. Sem o segundo, uma cópia instalada a partir de arquivo nunca atualiza. Referência das chaves: https://violentmonkey.github.io/api/metadata-block/

**`@run-at document-start`.** A correção de miniatura grava em `localStorage` antes de o Masonry ler as configurações no arranque. Rodar depois não tem efeito até a próxima recarga.

**Listeners na `window`, nunca em `document.body`.** O Masonry chama `document.documentElement.replaceWith(cloneNode(true))` e depois sobrescreve `document.head.innerHTML` e `document.body.innerHTML`. Tudo que estiver preso ao body é destruído. O `document` em si nunca é trocado, então o `MutationObserver` observa `document` e o painel é remontado quando `panelHost.isConnected` vira falso.

**Painel em Shadow DOM.** O CSS do Masonry usa `!important` em `html, body` e um reset global de `box-sizing`. Sem isolamento o painel desmonta. Como consequência, a camada de gestos identifica toques no painel via `ev.composedPath()`, não via `closest()`.

**Painel bilíngue, log em inglês.** A tabela `I18N` traduz só a moldura do painel; as linhas de log ficam em inglês de propósito, porque existem para ser coladas em issues. As duas tabelas de idioma precisam ter exatamente as mesmas chaves — há um teste para isso abaixo. Os rótulos são fixados quando o painel é construído, então trocar de idioma chama `rebuildPanel()`.

**Sem build, sem dependências.** Arquivo único, ES2020, nenhum import. O Greasy Fork rejeita código ofuscado ou minificado, e o repositório existe para ser auditável.

---

## Como o script conversa com o Masonry

Estes são fatos verificados no código do Masonry. Se algum quebrar, é porque ele mudou de versão.

| Ponto de contato | Detalhe |
|---|---|
| Navegação | `window.addEventListener('keyup', ...)` com `A`/`←`, `D`/`→`, `F`. Disparamos `KeyboardEvent` sintético. Tem `debounce(500, immediate)`, então gestos em rajada são engolidos. Só funciona com "Listen for keyboard events" ligado nas configurações do Masonry. |
| Botões da barra | Selecionados pelo atributo `d` do `<path>` do ícone MDI, que é único. `.click()` funciona mesmo com `display:none` — o handler do Vue dispara. |
| Detalhe aberto | `.img_detail_cont` presente no DOM. |
| Modo lupa | `.img_scale_scroll` presente. Nele o arrasto é pan, então swipe é ignorado. |
| Vídeo tocando | `.img_detail_cont .dplayer` presente. |
| Cards | `.posts-image-card`; o tipo vem do `d` de **qualquer** ícone em `.posts-image-type` (no yande.re/konachan o ícone de pai/filho vem antes). No layout padrão o card é um `<v-img>` — `div.v-image__image` com `background-image`, sem `<img>`; só os layouts "virtual" e "justified" usam `<img>`. Leia e troque a imagem via `cardPicture()`. |
| Configurações | `localStorage['YM_APP_SETTINGS']`, lido no arranque do app. |
| Páginas do próprio site | Fora do Masonry (Gelbooru 0.2): `.image-list > span.thumb > a > img`, tags no `title` (favoritos) ou `alt` (listagem). O `<a>` faz o papel de card para capa e GIF; o feed (`nativeFeed`) é só CSS (`FEED_CSS`). |

Bugs do Masonry que este script contorna:

- `getImgSrc` só usa `sampleUrl` se `isThumbSampleUrl || (colunas != 0 && colunas < 7)`. Colunas em "Automático" valem `0`, então a condição nunca passa — e automático é o padrão.
- `fancyboxShow` monta itens com `src: e.jpegUrl || e.fileUrl`, mas vários adaptadores devolvem `fileUrl: ""` de propósito.
- `isRule34Firefox()` usa `||`, então o Firefox cai no raspador de HTML mesmo com credencial de API.
- Detecção de GIF e vídeo por tag (`tags.includes('gif')`) em vez de por `fileExt`, o que falha em sites que não tagueiam. No raspador do rule34 (`src/api/rule34.ts`) o `fileExt` só pode ser `mp4` ou `jpg`: GIF com tag `video` ganha ícone de vídeo (a capa cai no caminho do GIF quando nenhum host de vídeo responde) e GIF sem essas tags não ganha ícone nenhum — esse caso ainda não tem solução.

---

## Mapa do arquivo

`image-board-helper.user.js`, seções na ordem:

1. Configuração persistida (`IBH_CFG`) e `setCfg`
2. Log — buffer de 250, níveis, espelho no console sob `debug`
3. `STATE` observável pelo painel
4. **A.** Miniatura nítida — `applySharpThumbs`
5. Resolução de servidor de imagens — `imageBase`, `thumbParts`, `fileCandidates`
6. **B.** Capa de vídeo e GIF inline — `mountCover`, `unmountCover`, `playGif`, `stopGif`, `IntersectionObserver`
7. **C.** Fancybox — `repairItems`, `wrapFancybox`, `installExtensionFallback`
8. **D.** Gestos — ponteiros, swipe, toque duplo, pinça
9. **E.** Miniatura original e feed nativo — `upgradeToOriginal`, `upgradeCandidates`, `sampleCandidates`, `probeOriginal`, `scanThumbs`
10. Opcional: `applyRule34ApiUnlock`
11. Diagnóstico — `probeVideoUrls`, `logSnapshot`
12. Painel — Shadow DOM, `renderStatus`, `copyLog`
13. Arranque e `window.__ibh`

---

## Armadilhas já pagas

Não sugira estas de novo sem um motivo novo.

**Capturar o frame do vídeo num `<canvas>`.** Foi a primeira tentativa. Exige `crossOrigin="anonymous"` e o CDN mandando cabeçalho CORS; sem isso o canvas fica sujo e `toDataURL` lança. Falhava calado. A solução atual sobrepõe um `<video muted preload="metadata">` e, quando os metadados chegam, pula para 35% da duração (`COVER_POINT`): o navegador desenha o frame e nada é exportado, então CORS não entra na conta.

**Derivar o arquivo do host da miniatura.** Alguns boorus servem miniatura e arquivo de hosts diferentes, e certos mirrors só têm miniatura — `miami.rule34.xxx` e `ny.rule34.xxx` são os mapeados. Dá 404 silencioso. O `imageBase()` resolve o host separado, ignora mirrors conhecidos, cai num fallback e guarda por sete dias.

**Forçar o caminho da API no rule34 por padrão.** Funciona, mas o raspador de HTML manda o cookie de sessão (`credentials: "include"`) e respeita a blacklist da conta, o `filter_ai` e o `post_threshold`. A API vai para `api.rule34.xxx`, host diferente, sem cookie. Trocar URL correta por perda dos filtros da conta é mau negócio; a opção existe mas vem desligada.

**Abrir uma capa de vídeo por card visível, sem limite.** No Oppo A5 o Firefox decodifica uns quatro vídeos ao mesmo tempo; o resto fica em `readyState` 1 para sempre ou dá `MEDIA_ERR_DECODE`. Medido com 18 `<video>` simultâneos pela `ffrdp`. Daí `COVER_MAX_LIVE = 3` e a fila. Aba em segundo plano não decodifica nada — teste de vídeo só com o Firefox na frente.

**Trocar o `src` da miniatura para mostrar a imagem melhor.** Quebra o Imagus (e afins), que reconhece a miniatura pelo padrão `thumbnail_` no `src`, e o Vue do Masonry pode desfazer. A troca vai no `srcset` via `imgPicture()`; o `src` fica como o site entregou.

**`touch()` dentro do que o painel chama ao se desenhar.** `renderStatus` → `readMasonryState` → `touch()` → `renderStatus` entrava em laço até estourar a pilha com o painel aberto, e a lista de status sumia sem aviso. O painel lê com `readMasonryState(false)` e `renderStatus` tem trava de reentrada.

**Consertar o Fancybox em sites de detalhe tardio.** Em sankaku, anime-pictures, allgirl, hentaibooru e kusowanka a URL só existe após o fetch de detalhe e não é derivável. Sem acesso a `store.imageList`, não há solução externa. O patch correto está no README e é no script original.

---

## Convenções de código

- Quando uma linha não é autoexplicativa, o comentário explica o que ela faz.
- Ao escrever código, me explique o que ele faz e como eu mesmo poderia ter chegado nele. Quero aprender junto, não só receber pronto.
- Prefira trecho inline curto a arquivo novo, salvo quando eu pedir o arquivo.
- Sugira alternativas mais eficientes quando existirem; se o ganho for irrelevante, não levante o assunto.
- Nada de parede de texto. Direto ao ponto.
- Toda função nova que mexe no DOM da galeria precisa ser idempotente: o `MutationObserver` reprocessa o mesmo nó várias vezes. Use `WeakSet` ou `dataset`.
- Todo recurso novo entra com uma chave em `DEFAULTS`, uma entrada no painel, uma linha de log e uma linha na tabela de opções dos dois READMEs. Se só vale no arranque do app, a chave entra também em `NEEDS_RELOAD`.
- A versão vive em dois lugares — `@version` no cabeçalho e `const VERSION` — e os dois sobem junto com uma entrada no `CHANGELOG.md`.
- Site novo precisa de uma linha `@match` no cabeçalho.
- Todo texto novo de painel entra nas duas tabelas de `I18N`. Texto de log é escrito direto, em inglês.
- Código e comentários em inglês no repositório. Comigo, no chat, fale português.
- Erro e aviso sempre vão ao console; `debug` só espelha o resto.

---

## Testar

Não existe harness de DOM local; o DOM real é inspecionado no aparelho via `tools/ffrdp.js` (abaixo). O que dá para verificar sem o celular:

```bash
node --check image-board-helper.user.js
```

E a paridade das tabelas de idioma, que quebra em silêncio:

```bash
node -e '
const src=require("fs").readFileSync("image-board-helper.user.js","utf8");
const I18N=new Function(src.match(/const I18N = \{[\s\S]*?\n  \}\n/)[0]+"return I18N")();
const en=Object.keys(I18N.en), pt=Object.keys(I18N["pt-BR"]);
console.log(en.filter(k=>!pt.includes(k)), pt.filter(k=>!en.includes(k)));
'
```

Funções puras (`thumbParts`, `fileCandidates`, `nextExtension`) podem ser extraídas com regex e rodadas num `new Function` com stubs — veja o padrão usado no histórico do projeto. Vale a pena quando mexer na derivação de URL.

O resto é testado no aparelho, pelo painel: **Testar URLs** lista cada candidata com OK ou FALHA, e **Copiar log** monta um relatório com `userAgent`, host resolvido, modo de miniatura e histórico. Com o painel desligado, o console tem `window.__ibh` (`cfg`, `state`, `log()`, `probe()`, `clearHostCache()`, `set(chave, valor)`).

Ambiente: Firefox para Android com Violentmonkey, num Oppo A5 4G. Sem PC na maior parte do tempo, então prefira mudanças que eu consiga aplicar e verificar pelo celular.

O container roda no próprio aparelho, então dá para olhar a tela pelo `rish` (Shizuku, `uid=2000 shell`):

```bash
rish -c 'am start -a android.intent.action.VIEW -d "https://yande.re/post" org.mozilla.firefox'   # abre no Firefox
rish -c 'input swipe 900 1200 200 1200 150'          # simula swipe; `input tap x y` para toque
rish -c 'screencap -p /sdcard/Download/ibh.png'      # depois leia /sdcard/Download/ibh.png direto do container
```

Isso mexe no celular que estou usando: peça antes de abrir app ou injetar toque. O console do Firefox não aparece no `logcat` (`GeckoConsole` vem vazio).

Para ler o estado do script na aba, `tools/ffrdp.js` fala o protocolo de depuração remota do Firefox (sem dependências):

```bash
node tools/ffrdp.js setup                          # adb connect 127.0.0.1:<porta> + forward tcp:6000
node tools/ffrdp.js tabs                           # lista as abas
node tools/ffrdp.js eval rule34 'window.__ibh.log()'   # aba por índice ou trecho da URL; resultado via JSON.stringify
```

- O `adb` (`android-tools`) já está pareado com a depuração sem fio do próprio aparelho — o pareamento é permanente. A porta de conexão muda quando a depuração sem fio reinicia; o `setup` acha a nova pelo mDNS e precisa ser rodado de novo.
- Requer "Depuração remota via USB" ligada no Firefox. Hoje o socket ativo é o do **Firefox Beta** (`org.mozilla.firefox_beta`), onde o Masonry está instalado; o `setup` usa o primeiro socket que achar.
- A conexão direta ao socket pelo container é bloqueada pelo SELinux; por isso o caminho passa pelo `adb`.
- `FFRDP_DEBUG=1` imprime cada pacote no stderr.
- `eval` só lê expressões síncronas; uma `Promise` volta como `{}`.

---

## Tarefas abertas

- `HOSTS` só tem o rule34 mapeado. safebooru, xbooru e realbooru podem ter mirrors próprios; descobrir com **Testar URLs** e preencher.
- Preview de vídeo no hover e no toque longo, reaproveitando um único elemento `<video>` — um por card derruba o Chrome do Android.
- GIF sem ícone no raspador do rule34: as tags só existem no HTML que o Masonry baixa. Interceptar o `fetch` da listagem e montar um mapa hash → tags resolveria isso e o item abaixo de uma vez.
- Downloads no caminho do raspador continuam usando o `fileUrl` errado do app. Investigar se dá para corrigir interceptando `fetch` e reescrevendo o host das miniaturas no HTML antes do app parsear.
