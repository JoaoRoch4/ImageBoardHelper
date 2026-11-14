---
name: phone-workflow
description: Como testar, depurar, medir e publicar o Image Board Helper no celular do usuário pelo servidor MCP `phone` (Firefox Beta + Violentmonkey num Oppo A5, controlado a partir do container Fedora no mesmo aparelho). Use sempre que o trabalho tocar o celular de qualquer jeito — fazer deploy ou instalar uma versão nova, "olha o log", "olha a screenshot", um bug que o usuário viu no celular, um slideshow do segurar ou um vídeo lento ou falhando, um id de post para investigar, a depuração sem fio (Wireless debugging) ou o Shizuku desligados, preferências do Firefox, rodar um build pesado nativo no Termux, ou conferir o repositório antes de publicar — mesmo quando o usuário não cita o MCP nem as ferramentas.
---

# Fluxo de trabalho no celular

O userscript só roda de verdade no celular do usuário: Firefox Beta com Violentmonkey, num Oppo A5 (SM6115: quatro decodificadores no máximo, vídeo por hardware até 1920×1088). Este container roda nesse mesmo celular, e o servidor MCP `phone` (`tools/phone-mcp.mts`) chega a ele por três caminhos: Shizuku (`rish`, uid shell), adb pela depuração sem fio do próprio celular, e o depurador remoto do Firefox redirecionado para tcp:6000. Toda ferramenta reconecta sozinha, então uma sessão que caiu custa uma chamada, não uma rodada de comandos.

## As regras, e por quê

- **É o celular na mão do usuário.** `input`, `open_url`, `deploy` e `firefox_pref` com `set`/`clear` mudam o que ele vê ou como o navegador dele se comporta. Use-os quando o usuário pediu isso, ou no deploy que vem depois de uma mudança que ele pediu. Ler (`tabs`, `script_log`, `screenshot`, `logcat`, `device`) pode a qualquer hora.
- **Nunca ligue a depuração sem fio você mesmo.** `settings put global adb_wifi_enabled 1` reinicia o adbd e mata o Shizuku. Quando uma ferramenta disser que ela está desligada, peça ao usuário para ligá-la (Developer options → Wireless debugging) e espere.
- **O log do script vive na página.** Qualquer recarga o apaga, e os números que o usuário acabou de produzir somem. O `deploy` salva antes o log de toda aba do site; antes de um `reload_tabs` manual, rode `log_snapshot`.
- **A aba visível é do usuário.** Recarregue só abas escondidas; peça ao usuário para atualizar a visível.
- **Uma aba escondida não é bancada de teste para vídeo.** O Firefox não decodifica nada numa aba em segundo plano, e os timers dela param: um `eval` com `await` que espera um `setTimeout` nunca volta ali (`fetch` volta). Testes de vídeo precisam do Firefox na frente.
- **Confira a versão antes de depurar.** Metade dos antigos relatos de "continua não funcionando" era uma aba na versão anterior. `tabs` mostra o `__ibh.version` de cada aba.

## Problemas de conexão

Comece pelo `status`; ele lê tudo sem mudar nada.

| O que o `status` ou uma ferramenta diz | O que significa | O que fazer |
|---|---|---|
| Wireless debugging off / not advertised | a chave do usuário está desligada, ou o Android a desligou | peça ao usuário para ligá-la, depois tente de novo |
| Shizuku not running | o servidor do Shizuku morreu | peça ao usuário para iniciá-lo no app do Shizuku; o adb continua funcionando enquanto isso |
| a primeira chamada ao celular numa sessão leva ~4 s | o MCP sobe a única sessão rish dele (uma máquina Java); os comandos seguintes levam ~50 ms | nada |
| Firefox debugger not reachable | o redirecionamento sumiu | qualquer ferramenta do Firefox o refaz; `connect force=true` para insistir |
| no tabs | o Firefox descarregou as abas (memória) ou está fechado, ou é o outro Firefox | peça ao usuário para abrir o site; o log das abas descarregadas se perdeu. O Beta e o Nightly têm os dois o script: `connect app=org.mozilla.fenix` (Nightly) ou `org.mozilla.firefox_beta`, que fica lembrado |
| "does not answer: Android freezes it in the background" | o app está congelado enquanto o usuário está em outro lugar (Termux) | peça ao usuário para trazer esse Firefox para a frente por um momento; um loop que tenta de novo a cada 2 s pega a janela |

## Publicar uma mudança

As regras do projeto (CLAUDE.md) vêm primeiro: versão nos dois lugares, entrada no CHANGELOG, os dois READMEs, `npm run check`. Depois:

1. Commit e push: o link raw é fixado no commit, então o commit precisa estar no GitHub.
2. `deploy`. Ele roda o `check`, salva o log de toda aba do site, copia o arquivo para `/sdcard/Download`, abre no Firefox Beta o link raw fixado no commit e acompanha o Violentmonkey, depois recarrega as abas escondidas do site. O relatório dele lista as linhas principais dos logs salvos: leia, é a última chance.
3. O Violentmonkey atualiza em silêncio, exceto quando os grants ou o `@resource` mudam: aí ele espera um toque. Diga ao usuário para tocar; `confirm: true` só toca por ele quando ele pediu.
4. `tabs` para ver a versão nova; a aba visível atualiza quando o usuário a recarrega.

`deploy dry_run=true` confere a cadeia inteira sem mexer no celular.

## Um bug que o usuário viu

1. `tabs`: a versão certa na aba que ele usou?
2. `script_log` com um `filter` (uma palavra do recurso, ou `error|warn`) e `levels`. As linhas de log são em inglês de propósito; o **Copiar log** do painel é o mesmo buffer.
   `console` lê o console do próprio Firefox para a aba: os erros da página e, com o debug do painel ligado, o log inteiro do script como linhas `[IBH]`. Funciona em abas escondidas. Toda ferramenta que age numa aba escreve antes uma linha `[Claude] …` nela, para o usuário ver no celular o que foi feito (o MobiDevTools a mostra pela ponte dele, já que não vê o console da página).
3. "Olha a screenshot" significa `latest_screenshot` (as do próprio usuário, em `/sdcard/Pictures/Screenshots`); `screenshot` captura a tela agora. Para algo que se mexe (um slideshow, um swipe), `screen_record` devolve uma folha de quadros de alguns segundos.
4. Fora da página (um app que não abriu, um crash): `logcat` com um filtro como `ActivityTaskManager|AndroidRuntime` e `since_s`. `apps url=<link>` diz quais apps aceitariam um intent.
5. Reproduzir um gesto você mesmo (`input long_press`, `tap`) precisa do sinal verde do usuário e de uma screenshot antes, para saber as coordenadas.

## O slideshow do segurar e os vídeos

O slideshow do segurar lê o índice do MP4 e um keyframe por cena (leituras com Range), depois os decodifica em WebAssembly (o H.264 do FFmpeg, `wasm/`) num canvas, ou, sem ele, toca um MP4 pequeno num `<video>`. Cada segurar registra uma linha `slideshow (…)` no log.

- `slideshow_stats` transforma essas linhas numa tabela com medianas por método (`saved=true` acrescenta os logs salvos pelos deploys). Fique de olho em "lifted before the first scene": o usuário desistiu de esperar, e esse é o número que mais importa.
- `video_info post=<id>` lê só o índice (algumas centenas de KB no máximo) e diz o codec, a resolução, o fps, o bitrate, a quantidade e o espaçamento dos keyframes, se o vídeo cabe no decodificador de hardware e o que um segurar vai fazer com ele, pelas regras do próprio script (reaproveita o leitor de MP4 do script).
- `reel_preview post=<id>` decodifica os keyframes que um segurar mostraria com o mesmo decodificador WebAssembly, aqui no Node, e os devolve numa folha de quadros com o tempo de decodificação de cada um. As imagens são o conteúdo do site: descreva-as só até onde a pergunta precisa.

Como ler os resultados: poucos keyframes e um clipe curto → toca a 2×; poucos keyframes e um vídeo longo → faz seek (lento, cerca de um segundo por cena); acima de 1920×1088 → sempre a fita, decodificada na CPU; não H.264 (WebM, HEVC) → a fita em `<video>` ou o seek.

## O servidor do celular

O `tools/phone-server.mts` roda nativo no Termux (janela `server` da sessão tmux `ibh`, iniciada no boot pelo Termux:Boot) em `127.0.0.1:8730`, com o token e o log na home do Termux (`~/.config/ibh-server/`). Ao contrário do Firefox, o Android não o congela.

- `server_call route=… body={…}` manda um pedido (o token é lido sozinho). Só leitura e seguras a qualquer hora: `status`, `apps`, `device`, `clipboard` (leitura), `file` (leitura), `screenshot`, e `run` para um comando nativo rápido sem janela do tmux (`body={"command":"…"}`, como uid 10307, tempo-limite ≤ 600 s). Estas mudam o que o usuário vê: `open` (um link num Firefox ou app escolhido), `notify` (com `url`, o toque o abre), `toast`, `input`. Use-as só quando pedido, como o `open_url` e o `input` do próprio MCP.
- `server_control action=start|restart|stop|log|install_boot`: `restart` depois de uma mudança no código dele (um servidor rodando mantém o código antigo); `log` é uma linha por pedido, nunca o corpo; `install_boot` escreve `~/.termux/boot/ibh-server.sh`.
- O mesmo a partir de uma shell: `node tools/phone-server.mts call <route> '<json>'`. Os testes dele: `npm run -s test:tools` (um servidor de verdade contra comandos falsos, sem celular).
- Lições do aparelho: o `/bin/df` do Android quebra no nativo e o netlink é negado a apps (por isso o `device` usa o `statfs` e o `networkInterfaces` do próprio Node); o Android recusa `am` ao Termux (por isso links e apps passam pelo rish, até o toque numa notificação); o "não perturbe" esconde as notificações, mas elas continuam na gaveta de notificações.

## Termux nativo

O proot rastreia todo processo, o que deixa os builds lentos: cada processo do compilador leva ~3,6 s no proot contra ~1 s no nativo, e o primeiro build do WebAssembly levou ~25 min no proot contra 12 no nativo (contando o cache único do Emscripten), com resultado idêntico byte a byte. O `~/.zshrc` do Termux sobe uma sessão tmux `ibh` desanexada em toda shell nativa, e o socket dela é compartilhado com o container.

- `termux_run command=… name=…` roda o comando nativo numa janela nova dessa sessão (os pacotes do próprio Termux no PATH, `emcc` incluído); `wait_s` espera os curtos. `termux_job id=…` dá o estado e a saída; sem id, lista os jobs recentes. O usuário pode acompanhar com `tmux attach -t ibh` numa sessão do Termux.
- `status` diz se a sessão está de pé; se não, qualquer sessão nova do Termux nativo a sobe (ou o usuário roda `tmux new -d -s ibh` lá).
- Sessões de verdade na gaveta do Termux não estão disponíveis: este build do Termux não roda o servidor de socket do termux-am, e o Android recusa `am` a apps.
- `wasm_build` compila o `wasm/h264dec.wasm` (nativo quando possível) e, chamado de novo com `job=…`, copia para `wasm/` um build nativo que deu certo. Depois: commit do `.wasm` primeiro, ponha esse commit no link do `@resource h264dec`, commit de novo.

## CSS: um layout que parece errado

Leia antes de chutar: a página do celular muitas vezes difere da que um navegador headless recebe (o rule34 serve o layout mobile dele, `mobile.css`, ao celular).

1. `css selector=…` mostra, de cada elemento que bate, a caixa, o estilo calculado e toda regra que bate com ele, na ordem das folhas de estilo, cada uma com a origem: a folha do site, o `<style data-ibh>` do script (THEME_CSS, FAVSEARCH_CSS e o resto), um atributo style, e qualquer condição `@media`. Qual regra ganha, e por quê, está ali. `shadow=true` olha dentro do shadow DOM do script (painel, player do modal); sem seletor, lista as folhas de estilo.
2. O culpado de sempre é a regra ampla do tema escuro (`html.ibh-theme body :not(…)`), que deixa todo fundo transparente e toda borda verde neon: um elemento do site que flutua (`position: absolute` ou `fixed`, um menu, um dropdown) então fica por cima da página. Um elemento assim precisa de um fundo próprio no THEME_CSS, como o `#navbar` e o `.awesomplete > ul` têm.
3. Para vencer uma regra do site sem `!important`, ganhe na especificidade (dois IDs vencem um: `#header #site-title`); contra a regra `!important` do tema, um seletor de ID com `!important` vence.
4. `try_css css=…` aplica uma folha de estilo de teste na aba (`shadow=true` para o painel ou o modal) para ver uma correção no celular antes de ela entrar no script; a chamada seguinte a substitui, `clear=true` ou uma recarga a remove. Muda o que o usuário vê: só quando pedido, e limpe depois.
5. Depois a correção entra no CSS do script, `check`, publicar. Essas ferramentas leem a página ao vivo, então aquele Firefox precisa estar na frente (um congelado não responde nada).

## Preferências do Firefox

`firefox_pref name=…` lê qualquer preferência do about:config pelo depurador, mesmo com o Firefox bloqueando o about:config nas versões release. `set` e `clear` persistem entre reinícios: só quando pedido, e diga que o `clear` desfaz. Já aprendido: `dom.media.webcodecs.enabled=true` expõe o WebCodecs no Android, mas todo codec responde que não é suportado, então não é um jeito de contornar o decodificador.

## Verificações

- `check`: `npm run check` (sintaxe, paridade do I18N, ESLint, TypeScript); uns 20 segundos. O `deploy` o roda.
- `smoke`: o teste do Playwright num Firefox headless no safebooru (o rule34 responde navegadores headless com CAPTCHA). Cerca de um minuto e pesado na memória: o Shizuku caiu e o Firefox descarregou as abas uma vez enquanto ele rodava, então não enquanto o usuário estiver no meio de alguma coisa.
