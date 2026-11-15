# Image Board Helper

**Português** · [English](README.md)

Userscript para celular nos boorus Gelbooru — rule34.xxx, gelbooru.com, safebooru e xbooru: visualizador de post dentro da página, feed nítido com colunas, capa real de vídeo e prévia de cenas, GIF animado na listagem, barras de busca com buscas salvas, busca nos seus favoritos, autopager, Ver depois e downloads, tudo de olho na memória do celular.

Funciona nas páginas do próprio site e só chama os endpoints do próprio site. Até a 0.64 era um complemento do [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry); essa versão continua na branch [`masonry-companion`](https://github.com/JoaoRoch4/ImageBoardHelper/tree/masonry-companion).

---

## O que faz

- **Visualizador de post.** Um toque numa miniatura abre o post sobre a página: vídeo com som e controles próprios, GIF, imagem (comic alto rola, pinça dá zoom). Swipe para o próximo post, favoritar e votar, tags, informações e comentários, download, Ver depois. Veja `videoModal` abaixo.
- **Feed.** De uma a quatro colunas ou automático, imagens inteiras ou quadros iguais, trocadas pelo sample: tão nítido quanto a tela do celular mostra, numa fração do tamanho do original.
- **Capa de vídeo.** Um `<video muted preload="metadata">` sobre cada miniatura de vídeo mostra um frame real. O navegador desenha e nada é exportado, então CORS não entra na conta, diferente de capturar o frame num `<canvas>`. Poucas por vez: o celular decodifica uns quatro vídeos ao mesmo tempo.
- **Prévia de cenas.** Arraste o dedo numa miniatura de vídeo para ver as cenas, ou segure para um slideshow.
- **GIFs** animam enquanto estão na tela, poucos por vez.
- **Busca.** Nas páginas de listagem, uma barra com tipo, ordem, score mínimo e um campo OU; buscas salvas e recentes; busca nos seus favoritos; autopager nas listagens e nos favoritos; favoritar em massa.
- **Memória.** O que rola para longe volta à miniatura, abas em segundo plano estacionam os vídeos, e um botão libera tudo.

---

## Instalação

1. Instale o [Violentmonkey](https://violentmonkey.github.io/) (Firefox para Android é o que roda estável hoje).
2. Abra o link bruto deste script para o Violentmonkey oferecer a instalação:

```
https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/image-board-helper.user.js
```

**Vindo da ponte de armazenamento** (`ibh-storage-bridge.user.js`, até a 0.64): o trabalho dela agora faz parte deste script. Mantenha a ponte instalada até o primeiro carregamento de página da 1.0 trazer as listas dela (Ver depois, índice de favoritos, buscas salvas; o log diz "moved in from the storage bridge"), e depois desinstale.

---

## Painel de status

Um botão redondo no canto inferior esquerdo abre o painel. Mostra o site, o host de imagens resolvido e a contagem de capas (ok / falha / total). As opções são persistidas, então dá pra ligar e desligar cada recurso sem editar o arquivo.

Ações úteis:

- **Testar URLs** — pega o primeiro card de vídeo na tela e testa cada URL candidata, registrando OK ou FALHA por host. É o jeito rápido de descobrir qual servidor serve os arquivos.
- **Limpar host** — apaga o cache de sete dias e resolve de novo, para quando o CDN mudar.
- **Copiar log** — monta um relatório com a versão, `userAgent`, host e o histórico.
- **Refazer miniaturas** — recomeça todas as miniaturas, inclusive as que falharam: as trocas voltam à miniatura e entram na fila de novo, capas e GIFs reiniciam, e o que está na tela é reprocessado na hora.
- **Limpar memória e cache** — para a prévia de cenas em andamento, fecha as capas de vídeo, volta os GIFs animados para a imagem parada (inclusive os que ainda carregam), desfaz as trocas por sample/original, pendentes e em andamento, e apaga o Cache Storage do site. O que está na tela volta na hora do cache do navegador, decodificado de novo: as imagens trocadas, as capas e os GIFs. O cache de endereços e o host de imagens ficam, porque quase não ocupam memória e são o que traz cada arquivo de volta com um pedido só. As outras abas do mesmo site com o script fazem o mesmo. O cache HTTP do navegador não é alcançável por script de página (fica no disco, não na RAM); configurações e login ficam.

O painel tem um seletor de idioma (automático, português, inglês). As linhas de log continuam em inglês de propósito: elas existem para serem coladas em issues, e relatório bilíngue é pior que relatório só em inglês.

O painel usa Shadow DOM, então o CSS do site não o alcança; toques dentro dele nunca começam uma prévia de cenas (verificado via `composedPath`).

**Pelo console.** O `window.__ibh` responde no console do navegador e num console de celular como o MobiDevTools ou o Eruda: `__ibh.help()` lista o que ele oferece, e `__ibh.tail(20, 'slideshow')` traz as últimas linhas do log (uma expressão regular deixa só as que batem). As duas devolvem texto em vez de imprimir, porque o MobiDevTools mostra o que uma chamada devolve, mas não o console da página.

---

## Opções

Todas ficam no painel e são gravadas em `localStorage` sob a chave `IBH_CFG`.

| Opção | Padrão | Efeito |
|---|---|---|
| `videoCovers` | ligado | sobrepõe o frame real do vídeo nas miniaturas de vídeo, poucas por vez |
| `thumbBadges` | ligado | nas miniaturas de vídeo, pequenos: a duração no canto inferior direito (assim que a capa, o índice de keyframes ou um segurar a conhece) e ⚠️ no canto superior direito quando o vídeo passa do decodificador de hardware do celular (mais de 1920×1088, ou acima da taxa do 1080p60). Precisa recarregar |
| `memorySaver` | ligado | imagens a duas telas de distância voltam à miniatura (e são trocadas de novo ao voltar), vídeos tirados da página são descarregados, e tudo é liberado ao sair da página. Imagens, GIFs e capas fora da tela também são varridos a cada 15 s e depois de cada rolagem, uma aba em segundo plano estaciona capas e GIFs, e a prévia de cenas libera memória antes de começar (requer recarregar) |
| `urlCache` | ligado | lembra qual endereço funcionou para cada arquivo (original, sample, pôster, GIF, vídeo) e, por um dia, quais não existem (uma falha só conta quando se repete um minuto depois, e nada é gravado sem rede ou em erro de rede), então imagens liberadas pela memória ou pelo modal voltam com um pedido só, sem refazer todos os hosts e extensões. Fica em dois lugares: o `localStorage` guarda as 1.500 mais novas, e o IndexedDB do site (banco `ibh-urls`) até 20.000, lidas cartão por cartão conforme a página é varrida, então ele sobrevive a outro script que limpe o `localStorage`. Entradas vencidas se apagam sozinhas. **Refazer miniaturas** apaga as falhas lembradas, **Limpar host** apaga tudo, e **Limpar memória e cache** o mantém |
| `videoScrub` | ligado | arrastar o dedo de lado numa miniatura de vídeo mostra as cenas (esquerda = começo, direita = fim); arraste vertical continua rolando e o toque continua abrindo o post. No modal, arrastar a barra de progresso mostra o frame sob o dedo (requer recarregar) |
| `scrubMode` | `drag` | gesto da prévia de cenas: `drag` escolhe a cena pela posição do dedo; `hold` passa as cenas como slideshow (a partir de 00:00, em loop, com o pulo e os segundos de `slideStep` e `slideDwell`; um segundo vídeo escondido carrega a próxima cena em paralelo) enquanto o dedo fica parado um instante na miniatura, e soltar para sem abrir o post. Em `hold` o menu do toque longo fica bloqueado nas miniaturas de vídeo |
| `holdVideo` | desligado | com `scrubMode` em `hold`: segurar a miniatura de um vídeo toca o próprio vídeo, do começo, mudo (veja `previewSound`), a 1× e em loop, num `<video>` que o Firefox decodifica no decodificador de hardware do celular (a GPU), em vez do slideshow de cenas decodificado na CPU. Um vídeo acima desse decodificador (mais de 1920×1088, ou acima da taxa do 1080p60: um 1080p a 120 fps) nunca toca: o slideshow de keyframes é forçado, na hora quando o tamanho ou o índice já dizem, ou um segundo depois de começar quando a taxa de quadros diz (buscando no arquivo quando não há índice para ler, como no WebM). Essa miniatura ganha o ⚠️ (`thumbBadges`) e o menu ☰ dela, o botão ⚡ 1080p. As opções do slideshow somem enquanto ela está ligada |
| `previewSound` | desligado | com `scrubMode` em `hold`: um segurar que toca o vídeo (`holdVideo`, ou um clipe curto que o slideshow toca a 2×) toca com som. O segurar começa por um timer, não dentro do toque, então o Firefox só libera o som depois de a página ter sido tocada; até lá ele toca mudo, como sem a opção. Ao soltar o dedo, a capa volta a ficar muda. Um segurar que toca mostra 🔊 ou 🔇 no canto superior esquerdo da miniatura, até um minuto depois de soltar: um toque troca esta opção (e tira o mudo de um segurar tocando, porque o toque faz o Firefox liberar o som) |
| `holdResume` | ligado | com `scrubMode` em `hold`: ao soltar o dedo de um segurar que toca o vídeo (`holdVideo`, ou um clipe curto a 2×), o ponto onde ele estava fica guardado por um minuto, e segurar o mesmo post de novo continua dali, com o som. Enquanto isso a miniatura mostra ⏮ e esse tempo; um toque nele esquece o ponto, a miniatura volta ao quadro dela, e o próximo segurar começa do início. Passado o minuto, o mesmo acontece sozinho. Os slideshows de cenas sempre começam do 00:00 |
| `holdRub` | ligado | segurar e então deslizar o dedo para o lado move o vídeo, na miniatura (com `scrubMode` em `hold`, enquanto o segurar toca o vídeo: `holdVideo`, ou um clipe curto a 2×) e no player do post, onde arrastar de lado sobre o vídeo já move (ou deslizar depois que o 2× do segurar começa; um vídeo pausado continua pausado). O deslizar o move: para a direita avança, para a esquerda volta, a partir de onde ele está; onde o dedo está não importa, só quanto ele desliza. A largura sob o dedo (a miniatura, o player) vale o vídeo inteiro, até 2 minutos. Enquanto o dedo se move, o vídeo para no quadro do ponto (o keyframe mais próximo, depois o exato) e o 2× sai; quando o dedo para, ele continua tocando dali na velocidade dele. No player um piparote rápido (menos de 0,3 s) continua trocando de post, e soltar no meio do deslizar continua tocando |
| `slideStep` | `10` | slideshow ao segurar: pulo entre cenas, em % do vídeo (5, 10, 20 ou 25: 20, 10, 5 ou 4 cenas por volta) |
| `slideDwell` | `0.2` | slideshow ao segurar: segundos que cada cena fica na tela depois de desenhada (0,1 a 1) |
| `slideReel` | ligado | slideshow ao segurar feito só de keyframes, para MP4: o script lê o índice do arquivo, baixa o keyframe de cada cena (de poucos KB a algumas centenas cada) e toca da memória num único vídeo, então cada cena depois da primeira aparece na hora, com um decodificador só. As quatro últimas fitas ficam guardadas para segurar de novo (**Limpar memória e cache** as descarta). Um clipe curto (até 30 s) com poucos keyframes toca em vez disso, mudo, em 2× e em loop; acima do decodificador de hardware (1920×1088), mesmo poucos keyframes viram fita. WebM e qualquer imprevisto voltam a fazer seek no arquivo, ou tocam o clipe curto |
| `wasmDecode` | ligado | com o `slideReel`, os keyframes são decodificados em WebAssembly (o decodificador H.264 do FFmpeg, veja Permissões) direto num canvas, no tamanho do card: sem elemento de vídeo, sem ocupar decodificador de hardware, e também em vídeos acima do limite de 1920×1088 do hardware. Cada quadro decodifica enquanto o anterior está na tela (dezenas de ms no celular). Desligado, ou em vídeos que ele não decodifica, a fita toca num vídeo como antes |
| `seekReel` | ligado | no player do modal, arrastar a barra de progresso mostra na hora o keyframe mais próximo: no primeiro arraste o script lê o índice do vídeo e 40 keyframes espalhados (como a fita do segurar faz) e os decodifica em WebAssembly no tamanho da prévia, guardando cada um depois de decodificado; o vídeo da prévia, que continua buscando, assume quando chega ao quadro exato sob o dedo parado. Só MP4 com H.264; WebM, HEVC ou uma falha ficam só com o vídeo da prévia |
| `playRate` | `1` | a velocidade do player do modal (0,5× a 2×), escolhida na ⚙ do player ou aqui; vale para todos os vídeos. A segunda linha da cápsula tem ▶/❚❚, ♥ (favorita e dá ▲; um favorito continua favorito, tire pelo ♥ de cima), ⓘ (a aba Info) e ⚙ |
| `seekStep` | `5` | quantos segundos o duplo toque no terço esquerdo ou direito do vídeo do modal pula (5, 10, 15 ou 30), escolhido na ⚙ do player ou aqui |
| `gifInline` | ligado | card de GIF anima enquanto está na tela e volta à imagem parada quando sai; GIF que quebra por falta de memória libera o que está fora da tela e é reconstruído, até duas vezes |
| `gifMaxLive` | `3` | com o `gifInline`, quantos GIFs animam ao mesmo tempo (1 a 10); os outros esperam como imagem parada e começam, os mais perto do centro da tela primeiro, quando outros saem da tela. Vale na hora |
| `holdGif` | ligado | segurar a miniatura de um GIF por meio segundo o constrói de novo: para um que quebrou, ficou na imagem parada ou falhou com a rede fora. As tentativas, a falha e a falha lembrada dele recomeçam; os outros GIFs da tela param até ele tocar (um segundo para os primeiros quadros, dez no máximo), e o que está fora da tela é liberado. Funciona também com o `gifInline` desligado, só para esse GIF |
| `originalThumbs` | **desligado** | troca as miniaturas visíveis pelo arquivo original, só onde a imagem aparece mais larga que o sample de 850 px em pixels do aparelho (tela de PC), porque o sample já é tão nítido quanto o celular mostra (uma página de quadrinho: 705 KB contra 51 MB do original) (requer recarregar) |
| `holdRaw` | ligado | nas páginas do site, segurar uma miniatura de imagem por meio segundo carrega o arquivo original (raw) no lugar do sample, com um selo RAW (segurar de novo volta ao sample); soltar não abre nada, rolar ou fazer pinça cancela. O menu do toque longo do navegador fica desligado nas miniaturas de imagem enquanto ela estiver ligada |
| `nativeFeed` | **desligado** | nas páginas do próprio site (rule34, gelbooru.com, safebooru, xbooru e outros Gelbooru 0.2): um feed com as colunas e o layout abaixo (por padrão, uma imagem por linha na largura toda da tela), trocada pelo sample (ou pelo original quando não houver) (vale na hora) |
| `feedColumns` | `1` | com o `nativeFeed`: `auto` (quantas colunas de 170px couberem na tela) ou de 1 a 4. Vale na hora |
| `feedLayout` | `masonry` | com o `nativeFeed` e mais de uma coluna: `masonry` mantém cada imagem inteira, em colunas; `grid` faz quadros quadrados iguais, cortados para preencher. Vale na hora |
| `feedNav` | ligado | com o `nativeFeed`, botões redondos no canto inferior direito, em duas fileiras: ⤒ topo, ‹ › post anterior/próximo (por exemplo para passar um comic longo), ⤓ fim da página; « » (canto superior esquerdo) página anterior/próxima pela paginação do próprio site (requer recarregar) |
| `bulkFavButton` | ligado | nas páginas do rule34 (logado), um botão ♥ ao lado do 🕒 liga o favoritar em massa: um toque numa miniatura favorita e vota no post em vez de abrir, e marca com ♥ (✕ se falhar). Toque no ♥ de novo para sair |
| `doubleTapFav` | ligado | no rule34 (logado), um toque duplo na miniatura favorita e vota no post sem abrir, e marca com ♥ (✕ se falhar), como o favoritar em massa; o toque simples continua abrindo o post, uns 0,3 s depois (a espera por um segundo toque) |
| `favsButton` | ligado | no rule34 (logado), um botão 🔖 no canto superior direito, ao lado do ♥ e do 🕒, abre a sua página de favoritos |
| `freeButton` | ligado | botão de atalho com ícone de lixeira junto dos botões flutuantes: um toque roda o **Limpar memória e cache** (inclusive nas outras abas do site) |
| `redoButton` | ligado | atalho ↻ ao lado da lixeira: roda **Limpar memória e cache** nesta aba e depois **Refazer miniaturas** (todas recomeçam, inclusive as que falharam) |
| `eyeButton` | ligado | um botão 👁 no canto inferior esquerdo, ao lado do ◐: um toque oculta todos os outros botões flutuantes (◐, os botões do feed, 🗑 ↻, « », 🕒 ♥ 🔖) para a página ficar sem nada por cima, o próximo traz de volta; lembrado entre páginas. Ocultar sai do favoritar em massa |
| `buttonsHidden` | desligado | definido pelo botão 👁, sem botão no painel |
| `laterButton` | ligado | nas páginas do site, um botão 🕒 no canto superior direito abre a lista **Ver depois** (posts salvos pelo botão 🕒 do menu ☰ de um post) em grade, no modal; um toque abre o post, o swipe passa pela lista, ✕ num quadro tira da lista. Guardada no armazenamento do Violentmonkey, no aparelho |
| `favSearch` | ligado | na sua página de favoritos do rule34, uma barra de busca: `tag`, `-tag`, `tag*`, `a ~ b`, `score:>10`, com filtro por tipo (imagens, vídeos, GIFs, animados) e score mínimo, e em ordem de mais novos, mais antigos, score ou aleatória. Todos os favoritos são indexados uma vez (guardados no armazenamento do Violentmonkey) e as visitas seguintes leem só os novos; os resultados entram na própria lista da página, então o feed, o modal e o resto funcionam neles. **Limpar** volta a página, **Refazer índice** lê todas as páginas de novo. toda busca entra sozinha em **Buscas recentes**, ☆ **Favoritar** guarda uma em **Buscas favoritas** (as duas também na barra do site), e a última busca nos favoritos volta na próxima visita |
| `favAutopager` | ligado | listagens de busca e páginas de favoritos (de qualquer pessoa) carregam a próxima página quando você chega perto do fim, e o swipe do modal continua por ela. O próximo endereço vem do paginador de cada página (nos favoritos ele não tem links de verdade, por isso as extensões de autopager falham ali) |
| `siteSearch` | ligado | nas páginas de listagem do site e na home (no lugar da caixa simples), uma barra de busca: tags, um campo OU (tags separadas por espaço viram `( a ~ b ~ c )`, e `||` abre outro grupo: `a b || c d` é `( a ~ b ) ( c ~ d )`, também na barra dos favoritos), tipo (imagens, vídeos, GIFs, animados), ordem (mais novos, score ou aleatória) e score mínimo, convertidos na busca do próprio site (`score:>=N`, `sort:score`, `sort:random`, `( a ~ b )`) e lidos de volta do endereço |
| `searchSuggest` | ligado | sugestões de tags ao digitar nas barras de busca do script (os campos de tags e de OU da barra do site, a busca nos favoritos): a palavra sendo digitada (com o `-` ou `~`) é perguntada à lista de sugestões do próprio site, a mesma da caixa de busca dele, e até 10 tags aparecem embaixo do campo com o número de posts e a cor do tipo; um toque troca a palavra pela tag. As listas de sugestões dos próprios sites também ganham fundo no tema escuro |
| `videoModal` | ligado | nas páginas do próprio site, tocar numa miniatura abre o post num player sobre a página: vídeo com som e controles próprios do player numa cápsula de vidro sobre a parte de baixo do vídeo (tempo atual, barra de progresso fina com o trecho já baixado em cinza, duração, som, tela cheia; um ▶ grande no vídeo pausado; somem em 2 s e um toque traz de volta; toque pausa/continua, arrastar de lado move o vídeo (`holdRub`), segurar no meio dá 2× (depois de 0,6 s), toque duplo na direita ou na esquerda pula ±5 s, toque duplo no centro alterna a tela cheia), GIF animado, imagem no original (comic alto rola; pinça dá zoom, toque duplo alterna a tela cheia (ou volta a 1× com zoom), segurar abre o menu ☰, um dedo arrasta com zoom). Swipe de lado ou ‹ › para o próximo/anterior (a página rola junto por baixo, sem carregar nada até fechar), swipe para baixo, ✕ ou o botão Voltar fecham, ☰ abre um menu com as tags do post em grade (artista, personagem e copyright primeiro, cada tipo na sua cor; um toque copia a tag, segurar abre a busca dela em outra aba, "Copiar todas" copia a lista) e ↗ para abrir a página do post em outra aba, com uma aba Info (tipo, resolução, formato, duração, quadros perdidos, estatísticas do post) e uma aba Comentários (▲ vota no comentário, o nome do autor abre o perfil); um toque fora fecha o menu, ⛶ tela cheia para qualquer post, ↻ gira a tela para a outra orientação em todos os posts até ser tocado de novo (entra em tela cheia, onde o Firefox permite), mostrando só o post: um toque na imagem traz a barra de volta, o vídeo mantém os controles, ♡ favorita e ▲ vota positivo (mostrando o score novo); os dois mostram o estado do post ao abrir: ♥ para post que já está nos favoritos (lido da página do post), ▲ aceso para favorito (o coração do site vota ao favoritar, e o ♡ também) ou post que você votou pelo modal ou pelos links de voto do site (lembrado no aparelho), e ♥ aceso tocado de novo tira dos favoritos. Vídeos sem tag de vídeo são detectados e o player vira vídeo. Enquanto ele está aberto, a página por baixo libera capas, GIFs e imagens trocadas, que voltam ao fechar (requer recarregar) |
| `rotateLandscape` | ligado | na tela cheia do próprio player do modal, vídeo mais largo que alto trava a tela em paisagem; fora da tela cheia nada gira |
| `modalPreload` | ligado | no modal, depois que o post da tela carrega, o próximo na direção em que você está indo é buscado: imagem ou GIF baixado e decodificado, então o swipe mostra na hora; vídeo com o host achado e o cabeçalho lido, então começa mais cedo. Só um post à frente |
| `playerButton` | ligado | no menu ☰ de um post de vídeo, dois botões para o app QtMediaPlayer do autor (`com.example.qtmediaplayer`). **▶ Media Player** toca o vídeo nele (um link de intent); o FFmpeg dele toca vídeos acima do decodificador de hardware do celular, na CPU. **⬇ App** abre a folha de compartilhar do Android, onde o **Download video** do app salva o arquivo na pasta Download do celular; abrir o arquivo no app oferece a conversão para 1080p quando ele passa do decodificador (o modal avisa quando abre um vídeo assim). Um intent não consegue mandar o site como Referer, que o servidor rápido de vídeo do rule34 exige, então o app recebe o servidor de origem, mais lento |
| `appBridge` | desligado | ⬇ App e ⚡ 1080p falam com o servidor do próprio app (`127.0.0.1:8745`, com o token que o app mostra, digitado no painel e guardado só no armazenamento do Violentmonkey) em vez do intent: o app baixa do servidor rápido do site, com o site como Referer, e a página avisa quando salvou ou converteu. Se o app não responde em 1,5 s (o Android o congela em segundo plano), vai o link de intent. O contrato é o `types/qtmediaplayer.d.ts` |
| `copyLinkButton` | ligado | **🔗 Copiar link** no menu ☰ do post copia o link do arquivo do próprio post: o original (raw) de uma imagem, mesmo com o sample na tela, e, para vídeo, um servidor que abre em qualquer lugar (o servidor rápido do rule34 exige o site como Referer para vídeos); segure para abrir o arquivo numa aba nova |
| `modalOriginal` | `zoom` | imagens no modal: `zoom` mostra o sample na hora (nítido no tamanho da tela) e carrega o original quando você dá zoom, mantendo o zoom (um botão SAMPLE / RAW, no canto inferior esquerdo, também troca à mão); `always` carrega o original direto (mais lento: originais chegam a dezenas de MB). O Baixar salva o original nos dois casos |
| `siteTheme` | ligado | o tema escuro do modal nas páginas do próprio site: fundo cinza-escuro azulado, texto claro, links, botões, campos e paginador em verde-água, linhas em verde neon (no gelbooru.com, o azul do próprio site nos dois, também no painel e no player), tipos de tag coloridos. Vale na hora |
| `blockAds` | ligado | bloqueia os anúncios para o bloqueador poder ficar desligado: uma Content-Security-Policy no cabeçalho da página só deixa carregar scripts e frames do próprio site (todo script de que esses sites precisam é deles), então as redes de anúncio, os popunders e os frames de afiliado nem são baixados, e os espaços vazios somem. WebAssembly, os scripts inline do site, extensões de devtools como o Eruda e a página de CAPTCHA da Cloudflare continuam funcionando. O log lista o que foi bloqueado (precisa recarregar) |
| `lang` | automático | idioma do painel: automático, português ou inglês |
| `debug` | desligado | espelha o log no console do navegador |
| `panel` | ligado | botão flutuante e painel |

### Armazenamento

As configurações ficam no `localStorage` (`IBH_CFG`), com uma cópia no armazenamento do Violentmonkey e outra no IndexedDB do site, que as trazem de volta se outro script limpar o `localStorage`. As listas (Ver depois, buscas salvas) ficam no armazenamento do Violentmonkey (`GM_getValue`/`GM_setValue`), no aparelho, então limpar os dados do site não as leva. Num gerenciador de userscripts sem armazenamento GM, elas ficam no IndexedDB do site. O índice de favoritos fica no IndexedDB do site (pode passar de alguns megabytes, e o Violentmonkey entrega o armazenamento dele ao script em toda página): limpar os dados do site o apaga, e a busca seguinte o lê de novo.

---

## Limitações conhecidas

**Mirrors só de miniatura.** Alguns boorus servem miniatura e arquivo de hosts diferentes, e certos mirrors não têm os arquivos. A lista fica em `HOSTS` no topo do script; hoje só o rule34 está mapeado. Se a capa falhar em outro site, use **Testar URLs** no painel para descobrir o host e adicione ali.

---

## Permissões

- `GM_getValue`, `GM_setValue` — as listas e a cópia das configurações (veja Armazenamento).
- `GM_xmlhttpRequest` com `@connect *` — o botão ⬇ Baixar. Um script de página não consegue ler arquivos dos servidores de imagem, que não mandam cabeçalho CORS. O script só pede aos servidores do próprio site (o site e os subdomínios dele, como `api-cdn.rule34.xxx`) e confere isso antes de cada download.
- `GM_getResourceURL` com `@resource h264dec` — o decodificador de keyframes do slideshow ao segurar: o decodificador H.264 do FFmpeg (LGPL 2.1+) compilado para WebAssembly a partir de `wasm/h264dec.c` e `wasm/build.sh`, que fixa o código do FFmpeg pelo hash. O Violentmonkey baixa uma vez junto com o script, de um link fixo num commit.
- `unsafeWindow` — põe o `window.__ibh` na `window` da própria página, para o console; com permissões GM, a `window` do script é um invólucro em volta dela.
- `@inject-into page` — roda o script no contexto da própria página, onde ele sempre foi testado nesses sites; as chamadas aos endpoints do site (favoritar, votar, comentários, páginas de favoritos) levam o login do site.

---

## Créditos

- Começou como complemento do [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry), por asadahimeka (MIT); essa versão está na branch `masonry-companion`
- Resolução de servidor de imagens e o teste de miniatura original inspirados no Booru Enhanced Dark Gallery

## Licença

MIT. Veja [LICENSE](LICENSE).
