# O app QtMediaPlayer: parte do projeto

Desde a 1.14.0 o Image Board Helper manda vídeos para o app do próprio usuário, o QtMediaPlayer, e o app é parte deste projeto: o que o script promete (tocar, baixar, converter para 1080p) só funciona com o app instalado e na versão certa. Este guia junta o que é preciso para compilar, instalar e manter o app a partir do celular. A seção "Integração com o QtMediaPlayer" do `CLAUDE.md` daqui é o contrato do lado do script; o `CLAUDE.md` do app é o do lado dele.

## O script é um userscript, não um programa

O Image Board Helper é **JavaScript num arquivo só, rodando no Firefox pelo Violentmonkey**, dentro da página do booru. Não tem build, não tem processo próprio, não roda comando, não lê arquivo do celular, não fala com o adb. Tudo o que ele faz com o app passa pelo que uma página consegue fazer:

- **Abrir um link de intent** (`intent://…#Intent;…;end`), que o Firefox entrega ao Android. Só vale dentro de um toque do usuário (ativação), senão o bloqueador de pop-ups barra, e o Firefox só abre intents BROWSABLE. O script não sabe se o app está instalado nem se o intent deu certo.
- **`GM_xmlhttpRequest` para `127.0.0.1:8745`** (`appBridge`), coberto pelo `@connect *`. É o único jeito de ler uma resposta do app. Se o app estiver fechado ou congelado pelo Android, a porta não responde, e o script cai no intent; ele não tem como abrir o app nem ligar o servidor sozinho.

Compilar, assinar e instalar o app, cuidar do Termux e do adb, tudo o que vem abaixo, é trabalho das sessões do Claude no container, com as ferramentas do repositório do app. Nada disso entra no `image-board-helper.user.js`. As ferramentas de `tools/` daqui (o `ffrdp`, o phone MCP, o smoke) também são de desenvolvimento, para testar o script; o script nunca as importa.

## Onde está

- **Repositório:** `JoaoRoch4/qtmobilemedia` (privado), em `~/projects/QtMediaPlayer` no container. App `com.example.qtmediaplayer`, "Media Player". Qt Quick (Qt 6.12), C++ e QML.
- **O contrato com o script:**
  - intent: `ACTION_VIEW` com o extra `com.example.qtmediaplayer.extra.MODE` = `play`, `download` ou `reduce` (no app: `PlayerActivity.EXTRA_MODE`);
  - servidor HTTP do app (`appBridge`): `types/qtmediaplayer.d.ts` aqui, `src/bridgeprotocol.*` e `src/scriptbridge.*` lá (branch `script-bridge`, ainda sem merge em 2026-11-14).
  - Mudou um lado, muda o outro junto.

## Compilar no celular

Sempre pelo script do projeto, `./buildApk.py`, de `~/projects/QtMediaPlayer` (nunca `cmake` à mão pelo `native`: o script cuida do boost, do log, das checagens e de abrir o app). `./buildApk.py --usage` lista tudo; as letras se combinam.

| Comando | O que faz |
|---|---|
| `./buildApk.py` | APK: compila, assina com a chave de release, instala por adb e abre |
| `./buildApk.py -xvl -j 8` | o mesmo com otimização máxima (ThinLTO, `-O3`, `build-max/`), Gradle detalhado (`-v`) e seguindo o log (`-l`), com 8 jobs |
| `./buildApk.py -n` | compila e assina, sem instalar |
| `./buildApk.py -t` / `-tx` | build para Termux:X11 (`build-termux/` / `build-termux-max/`) e abre lá; `-r` não abre |
| `./buildApk.py -g` | build na nuvem (GitHub Actions); o celular só assina e instala |
| `./buildApk.py -K` | para o run mais novo e desfaz o boost (nunca matar por PID) |
| `./buildApk.py -b` | sem o boost (não suspende os apps nem o Firefox) |

- **O boost** suspende os apps do usuário e todo Firefox, desliga a economia de bateria e liga o modo de alto desempenho; desfaz no fim. Precisa de adb ou Shizuku: sem eles o build roda sem boost e avisa.
- **Jobs:** sem `-j`, o script escolhe de 2 a 4 pela memória livre. A regra da casa é `-j 3`; mais que isso só a pedido do usuário.
- **Logs:** `logs/buildApk-<preset>-<data>.log` no projeto do app.
- **Tempo de referência (2026-11-14):** primeiro build do zero, com o vcpkg compilando as 30 bibliotecas, cerca de 1 h 50 min; o C++/QML do app, cerca de 28 min com `-x`.

## Antes de um build longo

O Android mata o Termux (e com ele o container, o Claude e o build) por três caminhos. Conferir pelo adb antes de começar:

```sh
S=127.0.0.1:<porta>   # adb devices mostra
adb -s $S shell 'device_config get activity_manager max_phantom_processes; settings get global settings_enable_monitor_phantom_procs'
```

- **Matador de processos fantasmas** (Android 12+): mata os filhos de apps acima de 32, e um build tem muitos. Se ler `null`, ligar de novo a proteção:
  ```sh
  adb -s $S shell 'device_config set_sync_disabled_for_tests persistent; device_config put activity_manager max_phantom_processes 2147483647; settings put global settings_enable_monitor_phantom_procs false'
  ```
- **Doze, bucket e appops:** `dumpsys deviceidle whitelist` deve listar `com.termux`; `am get-standby-bucket com.termux` deve dar 5 (EXEMPTED); `cmd appops get com.termux RUN_IN_BACKGROUND` deve dar `allow`. Já estavam assim em 2026-11-14.
- **lmkd** (falta de memória): o usuário shell não alcança. Só ajuda memória livre: o boost, um build pesado por vez, nada de app pesado aberto durante o link do ThinLTO. A última morte do Termux por isso foi em 2026-11-13 (`dumpsys activity exit-info com.termux`, `reason=3 (LOW_MEMORY)`).
- **Temperatura:** `dumpsys thermalservice | grep "Thermal Status"`; a partir do status 2 o ColorOS corta a frequência dos núcleos.

## adb pela depuração sem fio

- **Nunca** ligar a depuração sem fio por `settings put global adb_wifi_enabled`: derruba o Shizuku. Pedir ao usuário: Configurações → Opções do desenvolvedor → Depuração por Wi-Fi.
- **Achar a porta** (muda toda vez que a depuração volta):
  - `adb-wifi` procura em 127.0.0.1;
  - quando ele não acha, o mDNS por um servidor adb próprio na porta 5038 acha: `adb -P 5038 mdns services`, depois `adb-wifi -p <porta>`.
- **Parear de novo** (só se a chave mudar): o diálogo "Parear com o dispositivo" mostra código e porta; `adb pair 127.0.0.1:<porta> <código>`.
- O `tools/ffrdp.mts` usa a conexão que o adb já tem; o mDNS é só o plano B (o servidor adb do Fedora, porta 5037, não tem mDNS).

## O pipeline do APK no Termux

Tudo na home do Termux (`/data/data/com.termux/files/home`), refeito em 2026-11-14 depois que a mudança do rootfs apagou o original. Para refazer do zero:

1. **SDK do Android** (`~/android-sdk`):
   - **cmdline-tools 22.0:** `commandlinetools-linux-15859902_latest.zip`, SHA-1 `040d3996a65543d22ec4bf73e4c37aa37a8d4af4`, descompactado em `cmdline-tools/latest`. A 23+ entrega o `sdkmanager` a um binário x86_64 que não roda aqui.
   - **Pacotes,** com o `sdkmanager` rodando no container (JDK 25 do Fedora):
     ```sh
     S=/data/data/com.termux/files/home/android-sdk; SM=$S/cmdline-tools/latest/bin/sdkmanager
     yes | $SM --sdk_root=$S --licenses
     $SM --sdk_root=$S "platforms;android-37.2" "platforms;android-37.1" "build-tools;37.0.0" "ndk;30.0.16248370"
     ```
   - **Versões mais novas:** as versões estáveis estão em `https://dl.google.com/android/repository/repository2-3.xml` (canal `channel-0`).
2. **NDK r30 para aarch64:** o NDK oficial só tem ferramentas x86_64. O `tools/android/termux-patch-ndk.sh` deste repositório faz a troca: o clang vira um wrapper do clang do Termux, os outros binários viram links para os do Termux, a toolchain do CMake aceita o host Android, o sysroot ganha um `libc++_shared.a`, e o `include` do resource dir do clang aponta para o do clang do Termux (os headers embutidos, como o `arm_neon.h`, são de uma versão do compilador).
   - **Rodar nativo,** depois de instalar um NDK e sempre que o clang do Termux mudar de versão:
     ```sh
     cp tools/android/termux-patch-ndk.sh ~/android-sdk/   # na home do Termux
     native sh -c 'P=/data/data/com.termux/files/usr; export PREFIX=$P HOME=/data/data/com.termux/files/home PATH=$P/bin:/system/bin; sh $HOME/android-sdk/termux-patch-ndk.sh $HOME/android-sdk/ndk/30.0.16248370'
     ```
   - **Conferir:** um C, um com NEON e um C++ `-shared -static-libstdc++` compilam com `--target=aarch64-linux-android36` e o `--sysroot` do NDK.
3. **Qt 6.12.0 para Android** (`~/Qt/6.12.0/android_arm64_v8a`):
   - **Versão:** a mesma do Qt do Termux (o host; hoje 6.12.0).
   - **Onde baixar:** `https://download.qt.io/online/qtsdkrepository/all_os/android/qt6_6120/qt6_6120_arm64_v8a/`; o `Updates.xml` dali lista os pacotes e as versões.
   - **O que baixar:** do pacote `qt.qt6.6120.android_arm64_v8a`, qtbase, qtsvg, qtdeclarative, qttools e qttranslations (o qtdoc não precisa); e os add-ons qtmultimedia, qtshadertools e qtimageformats.
   - **Conferir:** cada `.7z` tem um `.sha1` ao lado.
   - **Extrair** nativo, com o 7z do Termux: `7z x -aos -o~/Qt/6.12.0/android_arm64_v8a <arquivo>.7z`. Os arquivos têm caminhos relativos (`bin/`, `lib/`).
4. **androiddeployqt:** o Qt do Termux não traz. É compilado a partir do qtbase v6.12.0 por `~/projects/src/androiddeployqt-termux` (CMake, nativo) e instalado em `$PREFIX/lib/qt6/bin/androiddeployqt`. Recompilar quando o Qt do Termux mudar de versão, e baixar o Qt para Android da mesma versão.
5. **Gradle:** `~/.gradle/gradle.properties` com `android.aapt2FromMavenOverride=/data/data/com.termux/files/usr/bin/aapt2`, porque o aapt2 do Maven é x86_64.
6. **OpenSSL:** não precisa mais. Desde 2026-11-14 o APK não leva o OpenSSL da KDAB (o TLS é do mbedTLS, dentro do FFmpeg e do curl, que o vcpkg compila), e o `~/android_openssl` que sobrou no Termux não é usado por nada.
7. **Pacotes do Termux:** `gradle`, `aapt2`, `apksigner`, `d8`, `openjdk-25`, `kotlin`, `cmake`, `ninja`, `clang`, `lld`, `7zip`, Qt 6.12 (`qt6-qtbase` e os outros). O vcpkg nativo fica em `~/vcpkg`, com os triplets em `~/vcpkg-triplets`; o `~/.termux_env.sh` exporta as variáveis dele, mas o `buildApk.py` passa as suas por conta própria.
8. **Chave de release:** `~/.android/release.keystore` e `~/.android/release.pass` no Termux, fora de qualquer repositório; cópia em `~/backup/termux-2026-10-27/.android/`. Sem ela o app nunca mais atualiza por cima: nunca trocar pela chave de debug, nunca desinstalar para contornar.

## Worktrees que compilam nativo

O Termux vê a home do container por outro caminho (`/data/data/com.termux/files/usr/var/lib/proot-distro/containers/fedora/rootfs/home/joao`). Um caminho absoluto do container no `.git` de um worktree quebra o git do lado nativo (o alvo `format` do app roda `git ls-files` nativo). O repositório do app tem `worktree.useRelativePaths true`. Ligar o mesmo em qualquer repositório cujos worktrees compilem pelo `native`, e depois rodar `git worktree repair`.

## Build na nuvem

- **Comando:** `./buildApk.py -g`, ou `gh workflow run build-apk.yml -R JoaoRoch4/qtmobilemedia --ref main`.
- **`startup_failure` com 0 jobs** é cobrança, não workflow quebrado: o GitHub recusou o cartão do usuário em 2026-11-13. O `gh` só diz "workflow file issue"; o motivo de verdade aparece na página do run.

## Recuperar o que se perdeu

As transcrições das sessões antigas do Claude guardam o conteúdo de arquivos que elas leram ou escreveram. O `termux-patch-ndk.sh` voltou assim.

- **Extrair só as transcrições do backup do rootfs,** nativo:
  ```sh
  tar --zstd -xf ~/backup/fedora-backup.tar.zst --wildcards "rootfs/root/.claude/projects/*"
  ```
- **Procurar nos `.jsonl`:**
  - `Write`/`Edit` do arquivo;
  - um `Read` dele;
  - um `cat` na saída de um `Bash`.
- **Reconstruir:** pegar a versão inteira mais nova e reaplicar as edições feitas depois dela, em ordem.
