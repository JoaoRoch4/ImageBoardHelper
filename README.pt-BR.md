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

Três ações úteis:

- **Testar URLs** — pega o primeiro card de vídeo na tela e testa cada URL candidata, registrando OK ou FALHA por host. É o jeito rápido de descobrir qual servidor serve os arquivos.
- **Limpar host** — apaga o cache de sete dias e resolve de novo, para quando o CDN mudar.
- **Copiar log** — monta um relatório com `userAgent`, host, modo de miniatura e o histórico.

O painel tem um seletor de idioma (automático, português, inglês). As linhas de log continuam em inglês de propósito: elas existem para serem coladas em issues, e relatório bilíngue é pior que relatório só em inglês.

O painel usa Shadow DOM porque o CSS do Masonry é agressivo com `!important` em `html, body`. Toques dentro dele são ignorados pela camada de gestos, via `composedPath`.

---

## Opções

Todas ficam no painel e são gravadas em `localStorage` sob a chave `IBH_CFG`.

| Opção | Padrão | Efeito |
|---|---|---|
| `sharpThumbs` | ligado | liga "miniatura usa imagem grande" (requer recarregar) |
| `videoCovers` | ligado | sobrepõe o frame real do vídeo |
| `fixFancybox` | ligado | preenche `src` vazio no Fancybox |
| `gestures` | ligado | swipe, toque duplo e pinça |
| `forceRule34Api` | **desligado** | ver abaixo (requer recarregar) |
| `lang` | automático | idioma do painel: automático, português ou inglês |
| `debug` | desligado | espelha o log no console do navegador |
| `panel` | ligado | botão flutuante e painel |

### Sobre `forceRule34Api`

A função `isRule34Firefox()` é:

```js
hostname == "rule34.xxx" && (UA inclui "Firefox" || !credentialQuery)
```

Por causa do `||`, o Firefox cai no raspador de HTML mesmo com credencial de API preenchida — e esse adaptador vem antes do da API em `fetchPostsActions`. Removendo a palavra `Firefox` do `userAgent`, a primeira metade fica falsa e a lista chega em `booruAction`, que usa a API e devolve `file_url` pronto.

**Desligado por padrão, de propósito.** O raspador manda o cookie de sessão (`credentials: "include"`) e respeita a blacklist da conta, o `filter_ai` e o `post_threshold`. A API vai para `api.rule34.xxx`, host diferente, sem cookie: você ganha URL correta e perde os filtros da sua conta.

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

---

## Créditos

- [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry) por asadahimeka — MIT
- Resolução de servidor de imagens inspirada no módulo `ImageServer` do Booru Enhanced Dark Gallery

## Licença

MIT. Veja [LICENSE](LICENSE).
