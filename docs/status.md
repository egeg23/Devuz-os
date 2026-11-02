# Где мы сейчас (читать первым)

Короткая памятка для любой сессии: что уже сделано, какие решения приняты,
на какие грабли уже наступили. Обновляется после каждого шага. Подробности —
в отчётах недель (`docs/week-NN.md`) и планах (`docs/plans/`).

## Состояние

| Неделя | Что | Итог |
|---|---|---|
| 1 | Образ Debian 13 + mkosi v27.1, systemd-boot + UKI, `/usr` на erofs, тест загрузки в Actions | ✅ `docs/week-01.md` |
| 2 | Ядро из Release по `kernel.lock`, dm-verity, счёт загрузок, `systemd-sysupdate` A→B, тест отката | ✅ `docs/week-02.md` |
| 3 | Secure Boot, подписи UKI / verity / обновлений, LUKS2 + TPM, root при первой загрузке | ▶ план `docs/plans/week-03.md` |

## Как устроено (одной строкой каждое)

- Сборка и все тесты — только GitHub Actions (`build.yml`); критерий готовности — зелёный Actions.
- Ядро: версия в `kernel.lock`, пакеты в GitHub Release `kernel-<версия>`; выкладывает `kernel.yml` (единственный workflow с правом записи).
- `tools/prepare-packages.sh` перед сборкой: ядро из Release + пустой пакет `devuz-no-initramfs` (чтобы не ставился dracut).
- Разметка: ESP, слоты A/B по три раздела (usr, usr-verity, usr-verity-sig), временный root. Ярлык слота `devuz_<версия>`, свободный — `_empty`.
- `/usr` под dm-verity: `usrhash=` в UKI, systemd находит разделы по UUID из хеша.
- UKI: `devuz_<версия>+3.efi` (3 попытки); `systemd-bless-boot` засчитывает после `devuz-ready.service`; `FailureAction=reboot`.
- Обновления: `/usr/lib/sysupdate.d/*.transfer`, адрес-заглушка `updates.devuz.invalid`; тест подменяет его через `/etc/sysupdate.d` и идёт с `--verify=no`.
- Тесты включаются учётными данными `devuz.test` (через SMBIOS, `mkosi vm --credential=`): `devuz-test.service` с `ConditionCredential=`; значения `selftest` или `update,<адрес>,<версия>`. Строку ядра для тестов не используем (под Secure Boot она из SMBIOS не берётся).
- Ручные режимы `build.yml` (`sabotage`): `no-kernel`, `emergency`, `corrupt-usr` (должны быть красными), `usr-only` (разведка).
- Ключи: тестовые генерируются в Actions на лету (`mkosi genkey`), в репозитории ключей нет никогда.

## Грабли, на которые уже наступили

- mkosi v27.1: `--console=read-only` требует `systemd-pty-forward` (нет в systemd 257) → тест на `--console=native`.
- mkosi v27.1: `+&c` (счётчик попыток в имени UKI) есть в man, нет в коде → `+3` пишем в `UnifiedKernelImageFormat=` сами.
- systemd 257 в initrd сам не находит `/usr` без verity → с verity работает по `usrhash=`.
- `systemd-pcrlock-*` падают в QEMU (swtpm без AES-128-CFB) → выключены в preset до решения по TPM.
- `ManifestFormat=changelog` качает журналы с `metadata.ftp-master.debian.org` и роняет сборку при его сбоях → только `json`.
- Кэш Actions для `mkosi.cache` не сохраняется (`tar` не читает `/etc/shadow` с правами 000) → кэша нет, сборка с нуля 2–3 мин.
- С пустым `/etc` в Debian нет `awk` и др. (ссылки через `/etc/alternatives`); самопроверка не должна зависеть от таких программ.
- В версиях есть точки: имена UKI сравнивать без регулярных выражений.
- Под Secure Boot systemd-stub не берёт строку ядра из SMBIOS → нужен другой способ включать самопроверку (неделя 3).

## Решения владельца

- PR сливаем squash сразу, как только Actions зелёный, не спрашивая.
- Сервер обновлений: пока на сервере владельца (DevUz), перед релизом — свой локальный.
- Сервер: пользователь `devuz-ci`, Claude Code + `claude remote-control` в tmux (сессия `claude`), папка `~/work/devuz-os`. Выход наружу — через HTTP-прокси владельца (настроен в `~/.bashrc` и `~/.claude/settings.json` на сервере; в репозиторий не кладём). `/dev/kvm` на сервере нет → сборки только в Actions. Облачная сессия к серверу не подключается: серверные задачи — через сессию Remote Control в приложении Claude Code.

## Открытые вопросы

- Ограничить `FailureAction=reboot`, чтобы не перезагружаться по кругу, если плохи обе версии (неделя 8, «Состояние»).
- Домен или IP + порт для сервера обновлений.
- До недели 5: своё ядро на долгой ветке или идём за backports.
