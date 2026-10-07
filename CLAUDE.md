# Image Board Helper

Userscript autônomo para celular nos boorus Gelbooru 0.2: rule34.xxx, safebooru e xbooru.

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

**Sem build, sem dependências.** Arquivo único, ES2020, nenhum import. O Greasy Fork rejeita código ofuscado ou minificado, e o repositório existe para ser auditável. O `package.json` só tem ferramentas de desenvolvimento (ESLint, TypeScript como verificador, Playwright); o script nunca importa nada delas. A única exceção é o `@resource h264dec`: o decodificador H.264 do FFmpeg em WebAssembly, compilado a partir do código-fonte por `wasm/build.sh` (FFmpeg fixado por hash) e referenciado por um link fixo num commit. Mudou o `.wasm`, commit primeiro e depois o link no cabeçalho.

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
| Anúncios | ExoClick (`a.magsrv.com/ad-provider.js` e zonas `ins[data-zoneid]`), TrafficStars (`cdn.tsyndicate.com/sdk/v1/ms.js`), um popunder num domínio que muda de nome (página do post) e um iframe de afiliado (`crakrevenue`), em `div.a_list` (`#top`, `#lmid`, `#lbot1-3`), `#nativemlist` e `#nativempost`. O xbooru tem o mesmo ExoClick; o safebooru, só o beacon da Cloudflare. Todo script legítimo dos três é do próprio domínio. O `blockAds` põe uma CSP no `<head>` (`AD_POLICY`) e esconde esses espaços. |
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
9. **C.** Prévia de cenas — arraste na miniatura (ou segurar, `scrubMode`) e prévia na barra do modal: `seekFraction`, `previewLoad`, `previewStop`, `borrowDecoder`, `onScrubDown/Move/Up`. O segurar usa a fita de keyframes (`slideReel`: `buildReel` lê o `moov` e os keyframes com Range pelo `GM_xmlhttpRequest`, `mp4VideoTrack`; `showReelWasm` decodifica cada keyframe no WebAssembly — `h264Decoder`, `decodeKeyframe`, `avcConfig` — e desenha num canvas; sem ele, `showReelVideo` toca o MP4 montado por `reelBlob`) e, se ela falha, `reelFailed` cai no slideshow por seek (`seekShow`, dois vídeos em revezamento, `tickSlide`); `logSlideStats` registra cada hold
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

**Baixar vídeo menor ou com `preload='metadata'` para a prévia de cenas.** O rule34 só tem o arquivo original de vídeo (sample é só de imagem), e MP4 não reduz resolução no download. Medido no aparelho: busca num trecho não baixado custa 1,5 a 10 s em vídeos de 2,5 a 9 min (~500 KB/s), e `metadata` não foi mais rápido que `auto`. O que ajudou foi esconder a espera: dois vídeos em revezamento no slideshow (`tickSlide`). Desde a 1.2.0, em MP4, a fita de keyframes evita o seek no arquivo: lê só o índice e o keyframe de cada cena (no vídeo de 15 min: 967 KB em vez de seeks num arquivo de 53 MB), e os quadros saem idênticos aos do original (PSNR infinito no `ffmpeg`).

**WebCodecs no Android.** No Firefox Beta 158, `dom.media.webcodecs.enabled` vem desligado; ligado, a API aparece, mas `isConfigSupported` responde false para H.264, VP8, VP9 e AV1, com hardware ou software (testado em 2026-10-06, preferência devolvida ao padrão). Por isso a fita monta um MP4 e toca num `<video>` em vez de decodificar os keyframes direto.

**Medir toque longo só com pointer events.** No Firefox para Android o toque longo termina de três jeitos (gravado com um logger de eventos na aba): `contextmenu` → `pointerup`; `contextmenu` → `pointercancel`; ou `pointercancel` ~110 ms depois do toque, sem `contextmenu`, quando o dedo treme dentro de algo rolável. Os eventos de toque (`touchstart`/`touchend`) seguem nos três casos, então o segurar mede neles (tempo, deslocamento ≤ 12 px, sem rolagem) e abre a aba no `touchend`, que conta como gesto do usuário. `window.open` de dentro de timer é barrado pelo bloqueador de pop-ups. Veja `chipGestures`.

**`GM_download` no Firefox para Android.** Mostra o diálogo de salvar mas revoga o link `blob:` na hora, e confirmar não salva nada. O `saveFile` baixa com `GM_xmlhttpRequest` e mantém o link vivo por 2 min (`BLOB_LIFE_MS`); o host de vídeo exige o Referer do site.

**`beforescriptexecute` para barrar os scripts de anúncio.** Era o jeito de impedir um `<script>` de rodar sem mexer em objeto da página, mas o Firefox 158 não tem mais o evento (testado na aba: não dispara e o script roda). Remover o elemento depois de o parser vê-lo não impede a execução. O `blockAds` usa uma `<meta>` de Content-Security-Policy, posta no `<head>` pelo observer antes de o parser chegar ao corpo, e assim os anúncios nem são baixados (no `smoke` do xbooru, nenhum pedido sai para outro host). A política precisa liberar `'unsafe-eval'` desde o início, porque políticas se somam e sem ele o `WebAssembly.compile` do decodificador é barrado; e não pode ter nonce, que desliga o `'unsafe-inline'` dos `onclick` do site.

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

- `npm run check` pega variável ou função que não existe mais, chave duplicada no `I18N`, as duas tabelas de idioma com chaves diferentes (`tools/check-i18n.js`, quebra em silêncio), código morto e erro de tipo. `types/userscript.d.ts` declara os `GM_*` e afrouxa o retorno do `querySelector` para `any`, em vez de casts pelo código; erro novo ali é sinal, não ruído. Também confere as ferramentas em TypeScript (`tsc -p tools`, estrito, com `noUncheckedIndexedAccess`): `tools/*.mts` são ESM que o Node 24 roda direto, apagando os tipos, então só vale sintaxe que se apaga (nada de `enum`), import de tipo é `import type` e o caminho leva a extensão (`./ffrdp.mts`). O ESLint não lê `.mts`; o `noUnusedLocals` faz o papel do `no-unused-vars`. O `WebAssembly` vem de `tools/webassembly.d.ts`, porque a biblioteca DOM do TypeScript fica de fora.
- `npm run smoke` (`tools/smoke.js`, ~1 min no aparelho) confere arranque, painel, barra de busca, botão 👁, feed, modal abrindo e fechando, autopager e ausência de erros. O rule34 responde CAPTCHA a navegador headless; o safebooru tem a mesma marcação. Outro site: `node tools/smoke.js '<URL da listagem>'`. É o mesmo motor do celular (Gecko), não o mesmo navegador: toque, decodificação de vídeo e o próprio Violentmonkey continuam sendo teste no aparelho. Pesa na memória do aparelho: enquanto ele rodava, o Shizuku caiu uma vez e o Firefox do celular ficou sem abas carregadas.
- `node tools/test.mts [URL]` abre o **rule34** (o padrão) no Firefox headless do Playwright do projeto, com o script injetado como no `smoke`, se passando pelo Firefox do celular (user agent, 360 px, DPR 2, toque). Com essa identidade o rule34 deixou entrar sem CAPTCHA na primeira vez, ao contrário do `smoke`. Relata versão, miniaturas e as últimas linhas do log (`--eval` roda uma expressão, `--shot` salva o print) e guarda um perfil em `~/.cache/ibh-test/profile`. Num desafio da Cloudflare, reabre o mesmo navegador **visível** numa tela virtual (Xvfb + x11vnc + websockify/noVNC, tudo em `127.0.0.1`, senha de uso único, Firefox em modo quiosque) e abre essa tela no Firefox do celular pelo `am` do `rish` (`--firefox` escolhe qual; `--solve` força). Começou em Python (`test.py`), mas o `websockify` não subia quando lançado de lá; do Node sobe em ~4,5 s. O zsh daqui não tem `/dev/tcp`: teste de porta é com `curl` ou Node. Docker não roda no proot (sem namespaces, cgroups nem root de verdade). Ver a tarefa aberta.
- O servidor MCP `browser` (`.mcp.json`) é o Playwright MCP num Firefox headless, sem o script injetado: serve para olhar de perto a marcação de um site (navegar, `browser_evaluate`, snapshot), como a das listagens do tbib e do realbooru. Fica fixado na 0.0.80 porque ela usa o mesmo Playwright 1.63 do projeto e roda no Firefox que o `npx playwright install firefox` já baixou (rev. 1543). O plugin `playwright` usa `@latest`, que procura o Chrome (não existe em arm64) e pediria outro Firefox a cada versão. Se o Playwright do projeto subir, suba os dois juntos. A primeira chamada leva ~30 s.
- O LSP (plugin `typescript-lsp`) roda no TypeScript 5 global, porque o 7 do projeto não traz `tsserver`. Serve para referências, definição e chamadas no arquivo de 6 mil linhas. O 5 é mais rígido com JS que o 7 (não aceita propriedade criada depois num objeto literal nem atribuição feita dentro de callback para estreitar tipo), e o script passa nos dois: erro novo no LSP é sinal. Para ver a lista inteira sem o LSP: `node /usr/local/lib/node_modules/typescript/bin/tsc -p .`. As dicas ★ (parâmetro sem tipo) são só sugestão.

O decodificador em WebAssembly (`wasm/`): `bash wasm/build.sh` recompila (o `configure` do FFmpeg leva uns 15 min no proot, porque cada teste abre processos rastreados; fica em cache em `~/.cache/ibh-wasm` e as recompilações seguintes levam ~20 s), e `node tools/wasm-test.js <arquivo.mp4> [cenas] [largura] [pasta]` decodifica os keyframes de um MP4 local com ele, mede decodificação e conversão de cores separadas e, com pasta, grava PPMs para comparar com o `ffmpeg` (no vídeo de 15 min em 854×480: 8–21 ms de decodificação e ~11 ms de conversão por quadro; PSNR de 44 dB contra o `ffmpeg`). No celular, na 1.4.0: o `.wasm` compila em 170 ms e cada keyframe leva 116–248 ms de 1218×1370 a 1800×2560, dentro do tempo por cena. Não edite o `build.sh` enquanto ele roda: o bash lê o script aos pedaços.

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

Para ler o estado do script na aba, `tools/ffrdp.mts` fala o protocolo de depuração remota do Firefox (sem dependências):

```bash
node tools/ffrdp.mts setup                         # adb connect 127.0.0.1:<porta> + forward tcp:6000
node tools/ffrdp.mts tabs                          # lista as abas
node tools/ffrdp.mts eval rule34 'window.__ibh.log()'   # aba por índice ou trecho da URL; resultado via JSON.stringify
```

- O `adb` (`android-tools`) já está pareado com a depuração sem fio do próprio aparelho — o pareamento é permanente. A porta de conexão muda quando a depuração sem fio reinicia; o `setup` acha a nova pelo mDNS e precisa ser rodado de novo.
- Requer "Depuração remota via USB" ligada no Firefox. O script está no **Firefox Beta** (`org.mozilla.firefox_beta`) e no **Nightly** (`org.mozilla.fenix`), que o usuário passou a usar em 2026-10-07. O `setup` escolhe pelo `FFRDP_APP` (ou pelo parâmetro), senão o primeiro socket; o phone MCP lembra a escolha (`connect app=…`, guardada em `~/.cache/ibh-mcp/firefox-app`), e `open_url`, `deploy` e `device` seguem esse Firefox.
- Firefox em segundo plano fica congelado pelo Android (estado de processo em cache): não aceita conexão, a fila do socket enche e o `adbd` registra `could not connect … (Try again)`. Só responde com o app na frente; o `withFirefox` diz isso em vez de um timeout seco.
- A conexão direta ao socket pelo container é bloqueada pelo SELinux; por isso o caminho passa pelo `adb`.
- `FFRDP_DEBUG=1` imprime cada pacote no stderr.
- `eval` só lê expressões síncronas; uma `Promise` volta como `{}`.

O servidor MCP `phone` (`tools/phone-mcp.mts`, sem dependências em tempo de execução, registrado no `.mcp.json`) junta tudo isso em 28 ferramentas, e cada uma reconecta sozinha quando a depuração cai. Celular e navegador: `status`, `connect`, `tabs`, `eval` (com `await`), `reload_tabs`, `open_url`, `firefox_pref` (about:config pelo depurador), `screenshot`, `latest_screenshot`, `screen_record` (folha de quadros de alguns segundos), `input` (toque, segurar, deslizar, tecla), `logcat`, `apps`, `device`. O script: `script_log`, `console` (o console do próprio Firefox de uma aba, pelo depurador: chamadas `console.*` e erros da página, aba escondida inclusive), `css` (de um seletor: caixa, CSS calculado e as regras que batem, cada uma com a origem e o `@media`, inclusive no Shadow DOM do script) e `try_css` (CSS temporário na aba, para testar uma correção ao vivo; some ao recarregar), `log_snapshot`, `slideshow_stats`, `deploy` (roda o `check`, salva o log de cada aba antes de recarregar, instala pelo link do commit). Vídeos e WASM: `video_info` e `reel_preview` (o índice do MP4 e os keyframes de um post, com o leitor de MP4 e o decodificador do próprio script), `wasm_build`. Repositório: `check`, `smoke`. Termux nativo: `termux_run` e `termux_job`, janelas de uma sessão tmux `ibh` fora do proot, que o `~/.zshrc` do Termux nativo sobe em toda shell (a primeira compilação do WASM levou 12 min lá, contando o cache único do Emscripten, contra ~25 no proot, e o `.wasm` saiu idêntico byte a byte; sessões de verdade na gaveta do Termux não dão, porque esta versão beta não roda o socket do termux-am e o Android recusa `am` a apps). O passo a passo de uso está na skill `phone-workflow` (`.claude/skills/phone-workflow/SKILL.md`). Numa aba escondida os timers param: `eval` com `await` que dependa de `setTimeout` não termina, `fetch` termina. O `rish` sobe uma máquina Java a cada chamada (de 1 a 12 s no celular), então o MCP mantém uma sessão dele aberta e manda cada comando pela entrada, com uma marca no fim: a máquina sobe uma vez (~4 s) e cada comando depois leva ~50 ms. O `rish` mistura stdout e stderr (um `echo` simples pode chegar pelo stderr), mas mantém a ordem, então os dois canais viram um fluxo só e a marca vem sempre por último. O ColorOS congela o processo do Shizuku quando ele fica ocioso. Cada ferramenta que age numa aba escreve antes uma linha `[Claude] …` nela, para você ver no celular. O MobiDevTools (o console no celular) não vê o `console` da página: ele troca o `console` no próprio content script, e da página só recebe o que chega pela ponte dele (`postMessage` com `_mdt`; medido pelo contador de erros: um `console.error` da página não conta, a ponte conta). Por isso a linha vai pelos dois caminhos. O Eruda, que se injeta como `<script>` na página, vê o `console` dela.

---

## Tarefas abertas

- **Resolver o CAPTCHA pelo celular (`tools/test.mts`)**, deixado de lado em 2026-10-07 a pedido do usuário. Funciona: o desafio é detectado, a tela virtual sobe e o `am start` abre o noVNC no Nightly ou no Beta (`shown in …`). Não confirmado: se o usuário vê a tela e consegue tocar no CAPTCHA por ela, e se o passe fica no perfil. Numa tentativa a página do Firefox visível fechou logo depois de abrir no celular (causa desconhecida; daí o modo quiosque e o `current()` que reabre a página); noutra o `goto` esperando `domcontentloaded` estourou 60 s na página de desafio, que fica carregando de propósito (agora espera só o `commit` e abre a tela antes). Próximo passo: rodar com o usuário olhando o Firefox, tirar um `screenshot` do celular com o noVNC aberto e acompanhar até passar.
- **Confirmar o `blockAds` (1.8.0) no aparelho**, com o AdGuard desligado: numa listagem e num post do rule34, ler `performance.getEntriesByType('resource')` (nada de `magsrv`, `tsyndicate`, `crakrevenue` nem o host do popunder), as linhas `ads: blocked` do log, tocar na página para ver se o popunder abre aba, e segurar um vídeo para ver `keyframe decoder: WebAssembly ready`. No `smoke` do xbooru nenhum pedido saiu para outro host, mas lá o script entra antes do que o Violentmonkey consegue.
- **Visual do player do modal: "cápsula de vidro"** (escolhido pelo usuário em 2026-10-07, implementação adiada a pedido dele). Cápsula arredondada flutuando acima da borda de baixo, fundo escuro translúcido com desfoque leve, na ordem `0:42 ━━━●─── 2:15 🔈 ⛶`; um ▶ grande no centro só com o vídeo pausado (pausar segue sendo o toque no vídeo; gestos iguais); ícones em SVG no traço do de tela cheia, sem o emoji 🔊; barra de posição fina com o tocado na cor do tema e o baixado em cinza, bolinha que cresce ao arrastar; some em 2 s como hoje; a prévia de cena sobe para cima da cápsula. Medir os quadros perdidos com e sem o `backdrop-filter` (o Adreno 610 é modesto): se pesar, fica só translúcida. Sem opção nova, porque é só visual. Mexe no CSS do player, na montagem dos controles (tempo em dois campos, ▶ central) e no `installVideoControls` (trecho baixado). Pedir o "sim" antes de começar.
- **Primeira cena da fita mais cedo.** No log de 2026-10-07, num vídeo de 1:08 em 1080p, a primeira leitura levou ~2 s, e em dois vídeos o usuário soltou o dedo antes da primeira cena; no toque seguinte a leitura recomeçou do zero. Ideias: não abortar a leitura ao soltar e guardar a fita para o próximo toque; primeira leitura de 1 MB (cada requisição pelo `GM_xmlhttpRequest` custa ~0,5 s, mais que baixar 1 MB a 6 MB/s); mostrar cada keyframe assim que ele chega, sem esperar todos (o primeiro costuma vir junto com o índice).
- `HOSTS` só tem o rule34 mapeado. safebooru e xbooru podem ter mirrors próprios; descobrir com **Testar URLs** e preencher.
- **Voltar com tbib e realbooru** (tirados do `@match` na 1.0.1): as listagens deles não usam `.image-list` — o tbib põe os `span.thumb` em `#post-list .content > div`, o realbooru usa `div.items > div.col.thumb` —, então a barra de busca não aparecia e o feed e o autopager não agiam. Generalizar o seletor da lista por site e testar cada um com `node tools/smoke.js '<URL>'`.
- safebooru e xbooru passam no `npm run smoke`; no aparelho (toque, vídeo, endpoints logados) só o rule34 foi testado de verdade. Favoritar em massa, 🔖 e a busca nos favoritos são só do rule34.
