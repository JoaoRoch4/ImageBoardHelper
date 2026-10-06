# Image Board Helper

Userscript autônomo para celular nos boorus Gelbooru 0.2: rule34.xxx, safebooru, tbib, xbooru e realbooru.

**A regra que define o projeto:** o script trabalha só com a página do próprio site — a marcação dela (`.image-list > span.thumb > a > img`) e os endpoints do site, chamados com o login do usuário. Não depende de outro userscript nem de serviço externo. Até a 0.64 era um complemento do [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry); essa versão está congelada na branch `masonry-companion` (com o CLAUDE.md dela) e não recebe recursos novos.

O repositório é em inglês: código, comentários, README.md e CHANGELOG. O `README.pt-BR.md` é a tradução, e este arquivo fica em português porque é instrução de trabalho, não documentação do projeto. Fale português comigo.

---

## Restrições invioláveis

Cada uma tem um motivo concreto. Não mude sem entender o custo.

**Permissões.** `GM_getValue`/`GM_setValue` guardam as listas e a cópia das configurações no Violentmonkey; `GM_xmlhttpRequest` com `@connect *` faz o Baixar, porque os servidores de imagem não mandam CORS e um script de página não lê o arquivo; `unsafeWindow` recebe o `__ibh`. Com qualquer `@grant`, a `window` do script é um invólucro do Violentmonkey: `window.foo = 1` fica só no script, por isso o `__ibh` vai na `unsafeWindow` (senão o `ffrdp eval` não o enxerga). Nenhum objeto da página é modificado (`fetch`, `history`, `navigator`); se um dia precisar, só o realm da página alcança esses objetos. O download só pede aos hosts do próprio site e subdomínios (`siteFile`).

**`@inject-into page`.** É o contexto em que o script sempre rodou e foi testado nesses sites: o `fetch` dele é o da página, e as chamadas aos endpoints levam o login. Com `auto`, o Violentmonkey cai no modo content quando o CSP do site bloqueia scripts de página. Não troque sem testar favoritar, votar, comentários e as páginas de favoritos.

**`@noframes` e `@downloadURL`.** Sem o primeiro, o script roda dentro de iframes e o painel pode montar lá. Sem o segundo, uma cópia instalada a partir de arquivo nunca atualiza. Referência das chaves: https://violentmonkey.github.io/api/metadata-block/

**`@run-at document-start`.** O `MutationObserver` começa antes de a página ser montada, então o tema e o feed entram enquanto o HTML é lido, sem piscar o layout padrão, e os listeners de captura já estão prontos no primeiro toque. A restauração das configurações (`restoreCfg`) também roda cedo.

**Listeners na `window`, em captura.** Rodam antes do `onclick` inline dos links (os favoritos navegam por handler inline) e não dependem dos nós que o autopager e a busca trocam. O `MutationObserver` observa `document`, e o painel é remontado quando `panelHost.isConnected` vira falso.

**Painel em Shadow DOM.** O CSS do site (e o do tema, de seletores amplos) não alcança o painel. Como consequência, toque no painel se identifica via `ev.composedPath()` (`insidePanel`), não via `closest()`.

**Painel bilíngue, log em inglês.** A tabela `I18N` traduz só a moldura do painel e do modal; as linhas de log ficam em inglês de propósito, porque existem para ser coladas em issues. As duas tabelas de idioma precisam ter exatamente as mesmas chaves — há um teste para isso abaixo. Os rótulos são fixados quando o painel é construído, então trocar de idioma chama `rebuildPanel()`.

**Armazenamento.** As listas (Ver depois, índice de favoritos, buscas salvas) ficam no armazenamento GM do script. As configurações ficam no `localStorage` (`IBH_CFG`), com cópia no GM e no IndexedDB do site, que voltam se outro script limpar o `localStorage` (o "Rule34 Favorites Search" fazia `localStorage.clear()`). Leia e grave sempre por `storeGet`/`storeSet`: os dois esperam `storeReady()`, a migração única da antiga ponte (`moveIn`), para nada gravado no carregamento (busca recente, índice de favoritos) passar por cima das listas trazidas dela. `STORE_KEYS` é a lista do que a ponte guardava; chave nova não entra lá, senão a migração espera por ela até o fim do prazo. Sem GM (outro gerenciador), tudo cai para o IndexedDB do site.

**Sem build, sem dependências.** Arquivo único, ES2020, nenhum import. O Greasy Fork rejeita código ofuscado ou minificado, e o repositório existe para ser auditável. O `package.json` só tem ferramentas de desenvolvimento (ESLint, TypeScript como verificador, Playwright); o script nunca importa nada delas.

---

## Como o script conversa com o site

Fatos verificados no rule34 (via `ffrdp` e XHR síncrono na aba logada). Se algum quebrar, o site mudou.

| Ponto de contato | Detalhe |
|---|---|
| Listagem | `.image-list > span.thumb > a > img`; tags no `title` (favoritos) ou no `alt` (listagem). O `<a>` faz o papel de card para capa e GIF. Vídeo: `img.webm-thumb` ou tag de vídeo; GIF por tag (`NATIVE_GIF`). Troque a imagem só via `imgPicture()`/`cardPicture()`. |
| CSS do site | O site injeta `.thumb { width; max-height: <tamanho da conta> !important }`: o feed (`feedCss`) precisa anular os dois, senão a imagem vaza sobre o post seguinte. |
| Paginação | Listagem: link `>` com `alt="next"`. Favoritos: `index.php?page=favorites&s=view&id=USER&pid=N`, 50 por página, mais novos primeiro; o paginador deles não tem links de verdade (por isso as extensões de autopager falham), e o `pageTarget` monta o endereço. |
| Favoritar | `/public/addfav.php?id=ID` responde `3` adicionado, `1` já estava, `2` deslogado; com `&toggle=1` remove e responde `4`. O coração do site também vota. |
| Votar | Post: `/index.php?page=post&s=vote&id=ID&type=up`, responde o score novo. Comentário: `/index.php?page=comment&id=POST&s=vote&cid=CID&vote=up`. |
| Página do post | `#heart-img` com `heart-added.svg` = favorito; tags em `li.tag-type-*`; estatísticas em `#stats li`; o link "Original image" é o arquivo exato. Comentários em `#comment-list > div#c<id>` (`.col1`/`.col2`), 10 por página, cursor no "Next »" de `#post-comments #paginator`. |
| Score nos favoritos | No script inline da página: `posts[ID] = { … score: 'N' }`. |
| Cookies | `user_id` (`userId`) e `comment_threshold` (`readCookie`). |
| Servidores (rule34) | Imagens pelo Cloudflare (`api-cdn.rule34.xxx`); vídeo em `api-cdn-mp4` (origem nginx, 0,4–0,6 MB/s) é reescrito para `api-cdn` (6–7 MB/s). Sample tem 850 px de largura. Vídeo sem o Referer do site dá 403. Cada 404 de extensão errada custa ~0,5 s — daí o cache de endereços. |

---

## Mapa do arquivo

`image-board-helper.user.js`, seções na ordem:

1. Configuração persistida (`IBH_CFG`, `DEFAULTS`, `NEEDS_RELOAD`) e `setCfg`
2. Textos da interface — `I18N`
3. Log — buffer de 250, níveis, espelho no console sob `debug`
4. `STATE` observável pelo painel
5. Resolução de servidor de imagens — `HOSTS`, `imageBase`, `thumbParts`, `fileCandidates`
6. Cache de endereços — `cacheGet`, `cacheSet`, `cachedFirst`, `flushUrlCache`, `clearUrlCache`
7. **A.** Capa de vídeo e GIF — `mountCover`, `unmountCover`, `COVER_MAX_LIVE` e a fila, `playGif`, `stopGif`, `IntersectionObserver`
8. **B.** Miniatura nítida e feed — `upgradeToOriginal`, `upgradePlan`, `sampleCandidates`, `probeOriginal`, `raceImage`, `scanThumbs`
9. **C.** Prévia de cenas — arraste na miniatura (ou segurar, `scrubMode`: slideshow com dois vídeos em revezamento, `startSlideshow`, `tickSlide`) e prévia na barra do modal: `seekFraction`, `previewLoad`, `previewStop`, `borrowDecoder`, `onScrubDown/Move/Up`
10. **D.** Gerenciamento de memória — `farViewport`, `releaseFar`, `pinHeight`, `onNodesRemoved`, `releaseAll`, varredura a cada 15 s
11. **E.** Modal de post (vídeo, GIF, imagem, swipe) — `openModal`, `closeModal`, `stepModal`, `showVideo`, `showImage`, `sniffVideo`, `installModalSwipe`, `installImageZoom`, `suspendPage`, `resumePage`; no mesmo bloco: estado de ♥/▲ (`postInfo`, `favoritePost`, `upvotePost`), armazenamento (`storeGet/storeSet`, `storeReady`/`moveIn`, IndexedDB `idbGet/idbSet`, `restoreCfg`), Baixar (`modalDownload`, `saveFile`), Ver depois (`showLater`), busca nos favoritos (`searchFavs`, `updateFavIndex`), favoritar em massa (`onBulkClick`), segurar para o raw (`holdRaw`), buscas salvas (`savedControls`), barra de busca do site (`ensureSiteSearch`, `homeSearchForm`, `orTags`), autopager (`favPagerNext`, `pageTarget`), menu de tags e abas Info/Comentários (`renderTags`, `readComments`, `voteComment`), próximo post pronto (`preloadAhead`)
12. Diagnóstico — `probeVideoUrls`, `logSnapshot`, `freeMemory`, `redoThumbs`
13. Painel — Shadow DOM, `renderStatus`, `copyLog`; botões flutuantes (`buildFeedNav`, `jumpPost`)
14. Arranque — `feedCss`/`applyFeed`, `THEME_CSS`/`applySiteTheme`, o `MutationObserver` e `__ibh` (na `unsafeWindow`)

---

## Armadilhas já pagas

Não sugira estas de novo sem um motivo novo.

**Capturar o frame do vídeo num `<canvas>`.** Foi a primeira tentativa. Exige `crossOrigin="anonymous"` e o CDN mandando cabeçalho CORS; sem isso o canvas fica sujo e `toDataURL` lança. Falhava calado. A solução atual sobrepõe um `<video muted preload="metadata">` e, quando os metadados chegam, pula para 35% da duração (`COVER_POINT`): o navegador desenha o frame e nada é exportado, então CORS não entra na conta.

**Derivar o arquivo do host da miniatura.** Alguns boorus servem miniatura e arquivo de hosts diferentes, e certos mirrors só têm miniatura — `miami.rule34.xxx` e `ny.rule34.xxx` são os mapeados. Dá 404 silencioso. O `imageBase()` resolve o host separado, ignora mirrors conhecidos, cai num fallback e guarda por sete dias.

**Abrir uma capa de vídeo por card visível, sem limite.** No Oppo A5 o Firefox decodifica uns quatro vídeos ao mesmo tempo; o resto fica em `readyState` 1 para sempre ou dá `MEDIA_ERR_DECODE`. Medido com 18 `<video>` simultâneos pela `ffrdp`. Daí `COVER_MAX_LIVE = 3` e a fila. Aba em segundo plano não decodifica nada — teste de vídeo só com o Firefox na frente.

**Trocar o `src` da miniatura para mostrar a imagem melhor.** Quebra o Imagus (e afins), que reconhece a miniatura pelo padrão `thumbnail_` no `src`. A troca vai no `srcset` via `imgPicture()`; o `src` fica como o site entregou.

**Originais no feed.** Com `originalThumbs`, o feed baixava originais de dezenas de MB (uma página de comic: 51 MB contra 705 KB do sample). O sample já é tão nítido quanto o celular mostra: o `upgradePlan` usa o sample sempre que ele cobre a caixa em pixels do aparelho (DPR 2).

**Redesenhar o painel de dentro do próprio desenho.** Algo chamado ao desenhar o status disparava outro desenho e entrava em laço até estourar a pilha com o painel aberto; a lista de status sumia sem aviso. `renderStatus` tem trava de reentrada.

**Ouvir toques direto no `<video controls>`.** Os controles nativos do Firefox engolem o toque real (só mostram/escondem a barra) e o evento não sobe para a página. Evento sintético despachado no elemento passa, então teste sintético não prova nada aqui. Os gestos ficam numa camada própria por cima do vídeo, e os controles nativos foram trocados por controles próprios (`installVideoControls`) na faixa de baixo — com os nativos, a barra deles ficava escondida atrás da camada, pior ainda em tela cheia. Em tela cheia o elemento é o modal inteiro (`modal.box`), não o `<video>`, e o Firefox às vezes solta a trava de paisagem: `onOrientationChange` trava de novo.

**Fechar o modal e voltar ao topo.** A entrada de histórico do modal fazia o Firefox restaurar a rolagem para o topo ao fechar. `history.scrollRestoration = 'manual'` em volta dela, e a página rola junto com o modal.

**Cachear os arquivos (bytes) em vez dos endereços.** Respostas de outro domínio chegam opacas (não viram blob para `img.src`), o `freeMemory` apaga o Cache Storage do site, userscript não registra Service Worker, e guardar blobs briga com o gerenciamento de memória. O cache HTTP do Firefox já guarda os bytes; o que faltava era lembrar qual candidata venceu — é isso que o cache de endereços faz.

**Baixar vídeo menor ou com `preload='metadata'` para a prévia de cenas.** O rule34 só tem o arquivo original de vídeo (sample é só de imagem), e MP4 não reduz resolução no download. Medido no aparelho: busca num trecho não baixado custa 1,5 a 10 s em vídeos de 2,5 a 9 min (~500 KB/s), e `metadata` não foi mais rápido que `auto`. O que ajudou foi esconder a espera: dois vídeos em revezamento no slideshow (`tickSlide`).

**Medir toque longo só com pointer events.** No Firefox para Android o toque longo termina de três jeitos (gravado com um logger de eventos na aba): `contextmenu` → `pointerup`; `contextmenu` → `pointercancel`; ou `pointercancel` ~110 ms depois do toque, sem `contextmenu`, quando o dedo treme dentro de algo rolável. Os eventos de toque (`touchstart`/`touchend`) seguem nos três casos, então o segurar mede neles (tempo, deslocamento ≤ 12 px, sem rolagem) e abre a aba no `touchend`, que conta como gesto do usuário. `window.open` de dentro de timer é barrado pelo bloqueador de pop-ups. Veja `chipGestures`.

**`GM_download` no Firefox para Android.** Mostra o diálogo de salvar mas revoga o link `blob:` na hora, e confirmar não salva nada. O `saveFile` baixa com `GM_xmlhttpRequest` e mantém o link vivo por 2 min (`BLOB_LIFE_MS`); o host de vídeo exige o Referer do site.

**`MediaCapabilities` para saber se um vídeo roda liso.** No Firefox para Android responde sempre "smooth/powerEfficient", até para 4K que o aparelho não aguenta (o decodificador do SM6115 vai até 1920×1088). A aba Info usa os quadros perdidos de `getVideoPlaybackQuality`, e capa acima de 1920×1088 fica no pôster.

---

## Convenções de código

- Quando uma linha não é autoexplicativa, o comentário explica o que ela faz.
- Ao escrever código, me explique o que ele faz e como eu mesmo poderia ter chegado nele. Quero aprender junto, não só receber pronto.
- Prefira trecho inline curto a arquivo novo, salvo quando eu pedir o arquivo.
- Sugira alternativas mais eficientes quando existirem; se o ganho for irrelevante, não levante o assunto.
- Nada de parede de texto. Direto ao ponto.
- Toda função nova que mexe no DOM da página precisa ser idempotente: o `MutationObserver` reprocessa o mesmo nó várias vezes. Use `WeakSet` ou `dataset`.
- Todo recurso novo entra com uma chave em `DEFAULTS`, uma entrada no painel, uma linha de log e uma linha na tabela de opções dos dois READMEs. Se só vale no carregamento da página, a chave entra também em `NEEDS_RELOAD`.
- A versão vive em dois lugares — `@version` no cabeçalho e `const VERSION` — e os dois sobem junto com uma entrada no `CHANGELOG.md`.
- Site novo precisa de uma linha `@match` no cabeçalho, e só se usar a marcação Gelbooru 0.2 (`.image-list > span.thumb`).
- Todo texto novo de painel ou modal entra nas duas tabelas de `I18N`. Texto de log é escrito direto, em inglês.
- Código e comentários em inglês no repositório. Comigo, no chat, fale português.
- Erro e aviso sempre vão ao console; `debug` só espelha o resto.

---

## Testar

O que dá para verificar sem o celular:

```bash
npm install                      # uma vez: ESLint, TypeScript, Playwright
npx playwright install firefox   # uma vez: o Firefox do Playwright (build arm64)
npm run check                    # sintaxe, ESLint e tipos (tsc --checkJs, nada é gerado)
npm run smoke                    # Firefox headless no safebooru, com o script injetado
```

- `npm run check` pega variável ou função que não existe mais, chave duplicada no `I18N`, as duas tabelas de idioma com chaves diferentes (`tools/check-i18n.js`, quebra em silêncio), código morto e erro de tipo. `types/userscript.d.ts` declara os `GM_*` e afrouxa o retorno do `querySelector` para `any`, em vez de casts pelo código; erro novo ali é sinal, não ruído.
- `npm run smoke` (`tools/smoke.js`, ~1 min no aparelho) confere arranque, painel, barra de busca, feed, modal abrindo e fechando, autopager e ausência de erros. O rule34 responde CAPTCHA a navegador headless; o safebooru tem a mesma marcação. Outro site: `node tools/smoke.js '<URL da listagem>'`. É o mesmo motor do celular (Gecko), não o mesmo navegador: toque, decodificação de vídeo e o próprio Violentmonkey continuam sendo teste no aparelho. Pesa na memória do aparelho: enquanto ele rodava, o Shizuku caiu uma vez e o Firefox do celular ficou sem abas carregadas.

Funções puras (`thumbParts`, `fileCandidates`, `orTags`) também podem ser extraídas com regex e rodadas num `new Function` com stubs — veja o padrão usado no histórico do projeto. Vale a pena quando mexer na derivação de URL ou na montagem da busca.

O resto é testado no aparelho, pelo painel: **Testar URLs** lista cada candidata com OK ou FALHA, e **Copiar log** monta um relatório com versão, `userAgent`, host resolvido e histórico. Com o painel desligado, o console tem `window.__ibh` (`version`, `cfg`, `state`, `log()`, `probe()`, `clearHostCache()`, `set(chave, valor)`, `stored()` — tamanho de cada lista guardada e o estado da migração; `moveAgain()` — junta de novo as listas da ponte, se uma aba antiga gravou nela depois da migração).

Ambiente: Firefox para Android com Violentmonkey, num Oppo A5 4G. Sem PC na maior parte do tempo, então prefira mudanças que eu consiga aplicar e verificar pelo celular.

O container roda no próprio aparelho, então dá para olhar a tela pelo `rish` (Shizuku, `uid=2000 shell`):

```bash
rish -c 'am start -a android.intent.action.VIEW -d "https://rule34.xxx/" org.mozilla.firefox_beta'   # abre no Firefox Beta
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
- Requer "Depuração remota via USB" ligada no Firefox. Hoje o socket ativo é o do **Firefox Beta** (`org.mozilla.firefox_beta`), onde o script está instalado; o `setup` usa o primeiro socket que achar.
- A conexão direta ao socket pelo container é bloqueada pelo SELinux; por isso o caminho passa pelo `adb`.
- `FFRDP_DEBUG=1` imprime cada pacote no stderr.
- `eval` só lê expressões síncronas; uma `Promise` volta como `{}`.

O servidor MCP `phone` (`tools/phone-mcp.js`, sem dependências, registrado no `.mcp.json`) junta tudo isso em ferramentas, e cada uma reconecta sozinha quando a depuração cai: `status`, `connect`, `tabs` (versão e visibilidade de cada aba), `eval` (com `await`), `script_log`, `reload_tabs` (só as escondidas, por padrão), `screenshot`, `latest_screenshot`, `open_url` e `deploy` (cópia em Downloads, link do commit, Violentmonkey acompanhado, abas conferidas; `dry_run` não toca no celular; `confirm` clica na confirmação de permissões novas). Numa aba escondida os timers param: `eval` com `await` que dependa de `setTimeout` não termina, `fetch` termina.

---

## Tarefas abertas

- **Log do ↻:** o botão de refazer chama `freeMemory(true)` (só esta aba) e a linha sai como "(asked by another tab)". Separar o motivo (botão, outra aba, refazer) no parâmetro e no log. Vai na próxima versão.
- **Primeiro `deploy` de verdade pelo MCP `phone`:** até agora só rodou em `dry_run`.
- `HOSTS` só tem o rule34 mapeado. safebooru, xbooru e realbooru podem ter mirrors próprios; descobrir com **Testar URLs** e preencher.
- tbib e realbooru estão no `@match` mas não usam `.image-list`: o tbib põe os `span.thumb` em `#post-list .content > div`, o realbooru usa `div.items > div.col.thumb`. O script carrega e monta o painel, mas a barra de busca não aparece, e o feed e o autopager são escritos para `.image-list` (visto com `npm run smoke`; o modal não foi conferido lá). Hoje o `@description`, os READMEs e o CHANGELOG os dão como suportados. Decidir: tirar os dois do `@match` e da documentação (uma 1.0.1 rápida) ou generalizar o seletor da lista por site (trabalho maior; testar cada um com `node tools/smoke.js '<URL>'`).
- safebooru e xbooru passam no `npm run smoke`; no aparelho (toque, vídeo, endpoints logados) só o rule34 foi testado de verdade. Favoritar em massa, 🔖 e a busca nos favoritos são só do rule34.
