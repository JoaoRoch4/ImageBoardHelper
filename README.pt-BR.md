# Image Board Helper

**Português** · [English](README.md)

Camada de correções para o userscript [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry) no celular: gestos de toque, miniaturas nítidas, capa real de vídeo e conserto do visualizador Fancybox.

Não modifica o Masonry. Roda ao lado dele e conversa pelas superfícies públicas — eventos de teclado, cliques em botões e `localStorage`.

---

## O que corrige

**Miniatura esticada.** O `getImgSrc` do Masonry só troca `previewUrl` por `sampleUrl` quando `isThumbSampleUrl || (colunas != 0 && colunas < 7)`. Com colunas em "Automático" o valor é `0`, a condição falha e você fica preso na miniatura pequena — que é o padrão. Ligamos `isThumbSampleUrl` antes do app ler as configurações, e daí ele mesmo escolhe a URL grande, por site.

**Capa de vídeo borrada.** Vídeo é excluído da troca acima, porque o `sampleUrl` de um vídeo é o próprio `.mp4` e não entra num `<img>`. Sobrepomos um `<video muted preload="metadata">` ao card: o navegador desenha o frame real e nada é exportado, então CORS não entra na conta — diferente de capturar o frame num `<canvas>`. Um `IntersectionObserver` garante que só cards visíveis abram decoder.

**Fancybox sem imagem.** O `fancyboxShow` monta os itens com `src: e.jpegUrl || e.fileUrl`, mas vários adaptadores devolvem `fileUrl: ""` de propósito: a URL só existe depois do fetch de detalhe, que apenas o visualizador nativo dispara. Interceptamos `Fancybox.show`, preenchemos os `src` vazios e instalamos a escada de extensões (`.jpeg → .jpg → .png → .gif`) que o visualizador nativo tem e o Fancybox não.

**Sem navegação por toque.** O Masonry escuta `keyup` na `window`. Traduzimos gestos em teclas sintéticas e em cliques nos botões da barra, localizados pelo atributo `d` do `<path>` do ícone.

---

## Gestos

| Gesto | Ação | Como é feito |
|---|---|---|
| Swipe ← | próxima imagem | tecla `D` |
| Swipe → | imagem anterior | tecla `A` |
| Swipe ↓ | fechar | botão da barra |
| Toque duplo | favoritar | tecla `F` |
| Pinça abrir | ampliar | botão da barra |
| Pinça fechar | reduzir | botão da barra |

Toque simples continua com o comportamento original do Masonry.

---

## Instalação

1. Instale o [Violentmonkey](https://violentmonkey.github.io/) (Firefox para Android é o que roda estável hoje).
2. Instale o [Yande.re Masonry](https://greasyfork.org/scripts/444885).
3. Abra o link bruto deste script para o Violentmonkey oferecer a instalação:

```
https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/image-board-helper.user.js
```

4. Recarregue a página uma vez. O Masonry lê as configurações no arranque.

> **Requisito:** "Monitorar eventos de teclado" precisa estar ligado nas configurações do Masonry, senão os swipes de navegação não fazem nada.

---

## Painel de status

Um botão redondo no canto inferior esquerdo abre o painel — fica longe do FAB de refresh do Masonry, que é à direita.

Mostra host de imagens resolvido, modo de miniatura, contagem de capas (ok / falha / total), estado do Fancybox e último gesto reconhecido. As opções são persistidas, então dá pra ligar e desligar cada correção sem editar o arquivo.

Ações úteis:

- **Testar URLs** — pega o primeiro card de vídeo na tela e testa cada URL candidata, registrando OK ou FALHA por host. É o jeito rápido de descobrir qual servidor serve os arquivos.
- **Limpar host** — apaga o cache de sete dias e resolve de novo, para quando o CDN mudar.
- **Copiar log** — monta um relatório com `userAgent`, host, modo de miniatura e o histórico.
- **Refazer miniaturas** — recomeça todas as miniaturas, inclusive as que falharam: as trocas voltam à miniatura e entram na fila de novo, capas e GIFs reiniciam, e o que está na tela é reprocessado na hora.
- **Limpar memória e cache** — para a prévia de cenas em andamento, fecha as capas de vídeo, volta os GIFs animados para a imagem parada (inclusive os que ainda carregam), desfaz as trocas por sample/original, pendentes e em andamento (o que está na tela recarrega do cache do navegador) e apaga o cache de host, o cache de endereços e o Cache Storage do site. As outras abas do mesmo site com o script fazem o mesmo. O cache HTTP do navegador não é alcançável por script de página (fica no disco, não na RAM); configurações e login ficam.

O painel tem um seletor de idioma (automático, português, inglês). As linhas de log continuam em inglês de propósito: elas existem para serem coladas em issues, e relatório bilíngue é pior que relatório só em inglês.

O painel usa Shadow DOM porque o CSS do Masonry é agressivo com `!important` em `html, body`. Toques dentro dele são ignorados pela camada de gestos, via `composedPath`.

---

## Opções

Todas ficam no painel e são gravadas em `localStorage` sob a chave `IBH_CFG`.

| Opção | Padrão | Efeito |
|---|---|---|
| `sharpThumbs` | ligado | liga "miniatura usa imagem grande" (requer recarregar) |
| `videoCovers` | ligado | sobrepõe o frame real do vídeo, nos cards do Masonry e nas páginas do próprio site |
| `memorySaver` | ligado | imagens a duas telas de distância voltam à miniatura (e são trocadas de novo ao voltar), vídeos que o Masonry remove são descarregados, e tudo é liberado ao sair da página. Imagens, GIFs e capas fora da tela também são varridos a cada 15 s e depois de cada rolagem, uma aba em segundo plano estaciona capas e GIFs, e a prévia de cenas libera memória antes de começar (requer recarregar) |
| `urlCache` | ligado | lembra qual endereço funcionou para cada arquivo (original, sample, pôster, GIF, vídeo) e, por um dia, quais não existem (uma falha só conta quando se repete um minuto depois, e nada é gravado sem rede ou em erro de rede), então imagens liberadas pela memória ou pelo modal voltam com um pedido só, sem refazer todos os hosts e extensões. Entradas vencidas se apagam sozinhas; guarda no máximo 1500. **Refazer miniaturas** apaga as falhas lembradas, **Limpar host** e **Limpar memória e cache** apagam tudo |
| `videoScrub` | ligado | arrastar o dedo de lado numa miniatura de vídeo mostra as cenas (esquerda = começo, direita = fim), no Masonry e nas páginas do próprio site; arraste vertical continua rolando e o toque continua abrindo o post. No modal, arrastar a barra de progresso mostra o frame sob o dedo (requer recarregar) |
| `scrubMode` | `drag` | gesto da prévia de cenas: `drag` escolhe a cena pela posição do dedo; `hold` passa as cenas como slideshow (a partir de 00:00, em loop, com o pulo e os segundos de `slideStep` e `slideDwell`; um segundo vídeo escondido carrega a próxima cena em paralelo) enquanto o dedo fica parado um instante na miniatura, e soltar para sem abrir o post. Em `hold` o menu do toque longo fica bloqueado nas miniaturas de vídeo |
| `slideStep` | `10` | slideshow ao segurar: pulo entre cenas, em % do vídeo (5, 10, 20 ou 25: 20, 10, 5 ou 4 cenas por volta) |
| `slideDwell` | `0.2` | slideshow ao segurar: segundos que cada cena fica na tela depois de desenhada (0,1 a 1) |
| `gifInline` | ligado | card de GIF anima enquanto está na tela e volta à imagem parada quando sai; GIF que quebra por falta de memória libera o que está fora da tela e é reconstruído, até duas vezes |
| `fixFancybox` | ligado | preenche `src` vazio no Fancybox |
| `gestures` | ligado | swipe, toque duplo e pinça |
| `originalThumbs` | **desligado** | troca as miniaturas visíveis, no Masonry e nas páginas do próprio site, pelo arquivo original; mais nítido, mas gasta várias vezes mais dados e memória (requer recarregar) |
| `nativeFeed` | **desligado** | nas páginas do próprio site (rule34, safebooru, xbooru e outros Gelbooru 0.2): um feed com as colunas e o layout abaixo (por padrão, uma imagem por linha na largura toda da tela), trocada pelo sample (ou pelo original quando não houver) (vale na hora) |
| `feedColumns` | `1` | com o `nativeFeed`: `auto` (quantas colunas de 170px couberem na tela) ou de 1 a 4. Vale na hora |
| `feedLayout` | `masonry` | com o `nativeFeed` e mais de uma coluna: `masonry` mantém cada imagem inteira, em colunas; `grid` faz quadros quadrados iguais, cortados para preencher. Vale na hora |
| `feedNav` | ligado | com o `nativeFeed`, botões redondos no canto inferior direito, em duas fileiras: ⤒ topo, ‹ › post anterior/próximo (por exemplo para passar um comic longo), ⤓ fim da página; « » página anterior/próxima pela paginação do próprio site (requer recarregar) |
| `sortButton` | ligado | botão ★ nas listagens de busca (site e Masonry): acrescenta `sort:score` à busca atual, ou tira, e recarrega na primeira página; fica aceso enquanto a busca está ordenada por score (requer recarregar) |
| `freeButton` | ligado | botão de atalho com ícone de lixeira junto dos botões flutuantes: um toque roda o **Limpar memória e cache** (inclusive nas outras abas do site) |
| `laterButton` | ligado | nas páginas do site, um botão 🕒 no canto superior direito abre a lista **Ver depois** (posts salvos pelo botão 🕒 do menu ☰ de um post) em grade, no modal; um toque abre o post, o swipe passa pela lista, ✕ num quadro tira da lista. Guardada no Violentmonkey com a ponte de armazenamento; sem ela, nos dados do site |
| `favSearch` | ligado | na sua página de favoritos do rule34, uma barra de busca: `tag`, `-tag`, `tag*`, `a ~ b`, `score:>10`, em ordem de mais novos, mais antigos, score ou aleatória. Todos os favoritos são indexados uma vez (guardados pela ponte) e as visitas seguintes leem só os novos; os resultados entram na própria lista da página, então o feed, o modal e o resto funcionam neles. **Limpar** volta a página, **Refazer índice** lê todas as páginas de novo |
| `videoModal` | ligado | nas páginas do próprio site, tocar numa miniatura abre o post num player sobre a página: vídeo com som e controles próprios do player (tocar/pausar, tempo, barra de progresso, som, tela cheia no canto inferior direito como no YouTube; somem em 2 s e um toque traz de volta; toque pausa/continua, segurar dá 2×, toque duplo na direita ou na esquerda pula ±5 s, toque duplo no centro alterna a tela cheia), GIF animado, imagem no original (comic alto rola; pinça ou toque duplo dão zoom, um dedo arrasta com zoom). Swipe de lado ou ‹ › para o próximo/anterior (a página rola junto por baixo, sem carregar nada até fechar), swipe para baixo, ✕ ou o botão Voltar fecham, ☰ abre um menu com as tags do post em grade (artista, personagem e copyright primeiro, cada tipo na sua cor; um toque copia a tag, segurar abre a busca dela em outra aba, "Copiar todas" copia a lista) e ↗ para abrir a página do post em outra aba, ⛶ tela cheia para qualquer post, ↻ gira a tela para a outra orientação em todos os posts até ser tocado de novo (entra em tela cheia, onde o Firefox permite), mostrando só o post: um toque na imagem traz a barra de volta, o vídeo mantém os controles, ♡ favorita e ▲ vota positivo (mostrando o score novo); os dois mostram o estado do post ao abrir: ♥ para post que já está nos favoritos (lido da página do post), ▲ aceso para favorito (o coração do site vota ao favoritar, e o ♡ também) ou post que você votou pelo modal ou pelos links de voto do site (lembrado no aparelho), e ♥ aceso tocado de novo tira dos favoritos. Vídeos sem tag de vídeo são detectados e o player vira vídeo. Enquanto ele está aberto, a página por baixo libera capas, GIFs e imagens trocadas, que voltam ao fechar (requer recarregar) |
| `rotateLandscape` | ligado | na tela cheia do próprio player do modal, vídeo mais largo que alto trava a tela em paisagem; fora da tela cheia nada gira |
| `modalPreload` | ligado | no modal, depois que o post da tela carrega, o próximo na direção em que você está indo é buscado: imagem ou GIF baixado e decodificado, então o swipe mostra na hora; vídeo com o host achado e o cabeçalho lido, então começa mais cedo. Só um post à frente |
| `siteTheme` | ligado | o tema escuro do modal nas páginas do próprio site: fundo cinza-escuro azulado, texto claro, links, botões, campos e paginador em verde-água, linhas em verde neon, tipos de tag coloridos. O Masonry mantém a interface dele. Vale na hora |
| `forceRule34Api` | ligado | automático, sem botão no painel: ver abaixo (requer recarregar) |
| `lang` | automático | idioma do painel: automático, português ou inglês |
| `debug` | desligado | espelha o log no console do navegador |
| `panel` | ligado | botão flutuante e painel |

### Ponte de armazenamento (opcional)

`ibh-storage-bridge.user.js` é um segundo userscript, pequeno, que guarda a lista Ver depois no armazenamento do próprio Violentmonkey, no aparelho, e por isso sobrevive a limpar os dados do site, e salva os arquivos do botão ⬇ Baixar do modal (`GM_xmlhttpRequest`, só dos servidores do próprio site; um script de página não consegue salvar arquivos dos servidores de imagem, que não mandam CORS; sem a ponte, o arquivo abre em outra aba). Ele existe porque o script principal precisa continuar com `@grant none` (mexe nos objetos da própria página) e o armazenamento GM exige `@grant`; os dois conversam por eventos na `window`. Instale por <https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/ibh-storage-bridge.user.js>. Sem ele, a lista fica no `localStorage` do site; na primeira vez que a ponte responde, a lista passa para ela.

### Sobre `forceRule34Api`

A função `isRule34Firefox()` é:

```js
hostname == "rule34.xxx" && (UA inclui "Firefox" || !credentialQuery)
```

Por causa do `||`, o Firefox cai no raspador de HTML mesmo com credencial de API preenchida — e esse adaptador vem antes do da API em `fetchPostsActions`. Removendo a palavra `Firefox` do `userAgent`, a primeira metade fica falsa e a lista chega em `booruAction`, que usa a API e devolve `file_url` pronto.

**Os filtros da sua conta vêm junto.** O raspador manda o cookie de sessão (`credentials: "include"`), então o site aplica a blacklist da conta, o `filter_ai` e o `post_threshold`; a API vai para `api.rule34.xxx`, host diferente, sem cookie. O site guarda esses filtros em cookies que a página lê (`tag_blacklist`, `filter_ai`, `post_threshold`), e o cliente booru do Masonry chama a API com o `fetch` da página, então o script filtra a resposta antes de o Masonry ler: URL correta, e o que o site esconderia continua escondido. Só age com credencial de API configurada no Masonry; sem ela, fica o raspador. Não há botão no painel; `__ibh.set('forceRule34Api', false)` desliga.

---

## Limitações conhecidas

**Sites de detalhe tardio.** Em sankaku, anime-pictures, allgirl, hentaibooru e kusowanka a URL do arquivo não está na listagem nem é derivável da miniatura. Daqui de fora não há como escrever em `store.imageList`, então nesses sites a correção do Fancybox precisa ser no script original:

```js
async function showImgModal(index) {
  if (settings.useFancybox) {
    const img = store.imageList[index]
    if (!img.fileUrl) await handlePostDetail({ value: img })
    fancyboxShow(store.imageList, index)
    return
  }
  store.imageSelectedIndex = index
  store.showImageSelected = true
}
```

**Mirrors só de miniatura.** Alguns boorus servem miniatura e arquivo de hosts diferentes, e certos mirrors não têm os arquivos. A lista fica em `HOSTS` no topo do script; hoje só o rule34 está mapeado. Se a capa falhar em outro site, use **Testar URLs** no painel para descobrir o host e adicione ali.

**Download.** No caminho do raspador, o `fileUrl` que o app guarda continua derivado da miniatura. A exibição é contornada por fora, mas o download usa esse valor direto e não é alcançável daqui.

---

## Por que `@grant none`

A interceptação do `Fancybox` e a leitura de `window.Fancybox` exigem o mesmo realm da página. Qualquer `@grant` coloca o script num sandbox onde `window` não é o `window` da página, e nada disso funciona. Por isso as opções ficam no painel e não em `GM_registerMenuCommand`.

O `@inject-into page` deixa a mesma escolha explícita: o padrão `auto` do Violentmonkey cai no sandbox quando o CSP do site bloqueia scripts de página, e aí as mesmas funções quebram em silêncio.

---

## Créditos

- [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry) por asadahimeka — MIT
- Resolução de servidor de imagens e o teste de miniatura original inspirados no Booru Enhanced Dark Gallery

## Licença

MIT. Veja [LICENSE](LICENSE).
