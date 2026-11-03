# Где мы сейчас (читать первым)

Короткая памятка для любой сессии: что уже сделано, какие решения приняты,
на какие грабли уже наступили. Обновляется после каждого шага. Подробности —
в отчётах недель (`docs/week-NN.md`) и планах (`docs/plans/`).

## Состояние

| Неделя | Что | Итог |
|---|---|---|
| 1 | Образ Debian 13 + mkosi v27.1, systemd-boot + UKI, `/usr` на erofs, тест загрузки в Actions | ✅ `docs/week-01.md` |
| 2 | Ядро из Release по `kernel.lock`, dm-verity, счёт загрузок, `systemd-sysupdate` A→B, тест отката | ✅ `docs/week-02.md` |
| 3 | Secure Boot, подписанные обновления, root при первой загрузке (LUKS2 + TPM), боевой образ без учётных данных | ✅ `docs/week-03.md` |
| 4 | Службы: Podman + quadlet с подписью контейнеров, сторож, PostgreSQL, Caddy, канал поддержки | ▶ план `docs/plans/week-04.md` |

## Как устроено (одной строкой каждое)

- Сборка и все тесты — только GitHub Actions (`build.yml`); критерий готовности — зелёный Actions.
- Ядро: версия в `kernel.lock`, пакеты в GitHub Release `kernel-<версия>`; выкладывает `kernel.yml` (единственный workflow с правом записи).
- `tools/prepare-packages.sh` перед сборкой: ядро из Release + пустой пакет `devuz-no-initramfs` (чтобы не ставился dracut).
- Разметка образа: ESP и слоты A/B по три раздела (usr, usr-verity, usr-verity-sig). Ярлык слота `devuz_<версия>`, свободный — `_empty`. Root в образе нет: его создаёт `systemd-repart` в initrd при первой загрузке (`/usr/lib/repart.d/50-root.conf`, пакет `systemd-repart` в initrd через `InitrdPackages=`); в QEMU диск растёт до 8 ГБ (`RuntimeSize=`).
- Root зашифрован: `Encrypt=tpm2` в `50-root.conf` — LUKS2, ключ в TPM по PCR 7 (Secure Boot) + подписанной политике PCR 11 (подпись в UKI, `systemd-measure`, тот же ключ). В initrd и образе `systemd-cryptsetup` и `libtss2-*` (systemd открывает их через dlopen). В тесте `TPM=yes` (swtpm).
- `/etc` при первой загрузке: `mkosi.finalize` сохраняет `/etc` сборки в `/usr/share/factory/etc`, `devuz-factory-etc.service` (до firstboot/sysusers/tmpfiles) копирует его в пустой `/etc`, ничего не перезаписывая. Мастер первой загрузки выключен (`systemd.firstboot=no` в UKI).
- `/usr` под dm-verity: `usrhash=` в UKI, systemd находит разделы по UUID из хеша.
- UKI: `devuz_<версия>+3.efi` (3 попытки); `systemd-bless-boot` засчитывает после `devuz-ready.service`; `FailureAction=reboot`.
- Обновления: `/usr/lib/sysupdate.d/*.transfer`, адрес-заглушка `updates.devuz.invalid`; тест подменяет его через `/etc/sysupdate.d`. Подпись `SHA256SUMS.gpg` проверяется (`gpg` в образе, открытый ключ в `/usr/lib/systemd/import-pubring.gpg`; в Actions тестовый GPG-ключ на лету, в образ — через `--extra-tree`).
- Два образа из одних рецептов. **Боевой** (без профиля) — артефакт и коробки: тестовых служб нет, в UKI `systemd.import_credentials=no` (учётные данные systemd не принимаются ни с ESP, ни из SMBIOS). **Тестовый** (`--profile=test`, `mkosi.profiles/test/`) — на нём все тесты загрузки: `devuz-test.service` с `ConditionCredential=devuz.test` (через SMBIOS, `mkosi vm --credential=`), значения `selftest`, `update,http://10.0.2.2:<порт>/,<версия>` (другие адреса отклоняются), `luks` (TPM открывает root; после изменения PCR 7 — как при чужих ключах Secure Boot — не открывает; ключ восстановления открывает), `emergency`. Workflow проверяет, что боевой образ без тестового.
- Ручные режимы `build.yml` (`sabotage`): `no-kernel`, `emergency`, `corrupt-usr`, `unsigned` (должны быть красными).
- Ключи: тестовые генерируются в Actions на лету (`mkosi genkey`), в репозитории ключей нет никогда.
- Secure Boot: `SecureBoot=yes`, `SecureBootAutoEnroll=no` (иначе тестовый ключ уедет в коробку); в тесте `Firmware=uefi-secure-boot` + `FirmwareVariables=custom` (нужен `virt-fw-vars` — добавлен в `mkosi.tools.conf`).

- Контейнеры: Podman (Debian 13) + quadlet. `/etc/containers/policy.json` — по умолчанию отказ, из любого реестра только образ с нашей sigstore-подписью (`matchRepository`), ключ `/usr/lib/devuz/keys/containers.pub` (в Actions — тестовый cosign 2.4 на лету, через `--extra-tree`). Тестовый реестр — `registry:2` на раннере, `10.0.2.2:5000` (адрес повешен и на `lo` раннера).

## Грабли, на которые уже наступили

- mkosi v27.1: `--console=read-only` требует `systemd-pty-forward` (нет в systemd 257) → тест на `--console=native`.
- mkosi v27.1: `+&c` (счётчик попыток в имени UKI) есть в man, нет в коде → `+3` пишем в `UnifiedKernelImageFormat=` сами.
- systemd 257 в initrd сам не находит `/usr` без verity → с verity работает по `usrhash=`.
- `systemd-pcrlock-*` падают в QEMU (swtpm без AES-128-CFB) → выключены в preset до решения по TPM.
- `ManifestFormat=changelog` качает журналы с `metadata.ftp-master.debian.org` и роняет сборку при его сбоях → только `json`.
- Кэш Actions для `mkosi.cache` не сохраняется (`tar` не читает `/etc/shadow` с правами 000) → кэша нет, сборка с нуля 2–3 мин.
- С пустым `/etc` в Debian нет `awk` и др. (ссылки через `/etc/alternatives`); самопроверка не должна зависеть от таких программ.
- В версиях есть точки: имена UKI сравнивать без регулярных выражений.
- mkosi v27.1: `--forward-journal` не работает (`systemd-journal-remote` из tools tree: «Unknown socket passed on fd:4», гость висит на `systemd-journal-flush`) → читаем консоль hvc0.
- mkosi v27.1 + `FirmwareVariables=custom` + tools tree: файл `OVMF_VARS_4M.fd` ищется на раннере, а не в tools tree → в workflow ставим `ovmf` на раннер.
- systemd-stub 257 дописывает к строке ядра `io.systemd.stub.kernel-cmdline-extra` из SMBIOS и под Secure Boot (отказ только в confidential VM): кто управляет SMBIOS (прошивка, гипервизор), может дописать и `usrhash=`. От того, у кого в руках диск, это не открыто (ESP не влияет на строку ядра подписанного UKI). Прежняя запись «под SB не берёт» была неверной (аудит недели 3).
- systemd-stub берёт `*.cred` с ESP (`/loader/credentials/`, `<UKI>.extra.d/`) без проверки подписи, а PID1 их импортирует → через `tmpfiles.extra` и т. п. — код от root. Закрыто `systemd.import_credentials=no` в боевом UKI; тестовые механизмы — только в профиле test (аудит недели 3).

## Решения владельца

- PR сливаем squash сразу, как только Actions зелёный, не спрашивая.
- Сервер обновлений: пока на сервере владельца (DevUz), перед релизом — свой локальный.
- Сервер: пользователь `devuz-ci`, Claude Code + `claude remote-control` в tmux (сессия `claude`), папка `~/work/devuz-os`. Выход наружу — через HTTP-прокси владельца (настроен в `~/.bashrc` и `~/.claude/settings.json` на сервере; в репозиторий не кладём). `/dev/kvm` на сервере нет → сборки только в Actions. Облачная сессия к серверу не подключается: серверные задачи — через сессию Remote Control в приложении Claude Code.

## Открытые вопросы

- **Ключ восстановления в боевом образе** (CodeRabbit, неделя 3): root запечатан только в TPM. Замена платы/TPM, сброс TPM или изменение PCR 7 (например, обновление `dbx` в прошивке, смена ключей Secure Boot) — и данные не открыть ничем. Нужен боевой путь: ключ восстановления при первой загрузке, выдача владельцу (не в образ), инструкция. Решить до первой коробки клиенту (неделя 8, «Состояние»/заводская настройка); заодно — как переживать обновления `dbx` (перезапечатать ключ после них).

- Ограничить `FailureAction=reboot`, чтобы не перезагружаться по кругу, если плохи обе версии (неделя 8, «Состояние»).
- Домен или IP + порт для сервера обновлений.
- `/etc` из заготовки копируется только при первой загрузке: новые файлы `/etc` из следующих версий в уже работающую коробку не придут. Решить до первых обновлений с изменениями `/etc` (вариант — `tmpfiles.d` `C+` для нужных каталогов).
- Ручной режим `sabotage=emergency` краснеет из-за упавшей службы, а не по признаку emergency в журнале — проверить детектор.
- Диск коробки — от 8 ГБ: при меньшем root не создастся (systemd-repart выходит без ошибки) — добавить понятное сообщение.
- До недели 5: своё ядро на долгой ветке или идём за backports.
