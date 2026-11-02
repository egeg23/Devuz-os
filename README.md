# DevUz OS

Своя операционная система для мини-ПК **«DevUz Box: ИИ-офис в коробке»**.

Основа — Debian 13 (trixie). Образ собирается программой
[mkosi](https://github.com/systemd/mkosi) (проект systemd) по схеме
[ParticleOS](https://github.com/systemd/particleos):

- загрузчик systemd-boot и UKI — «единый образ ядра» (ядро, initrd и
  строка запуска одним файлом);
- `/usr` — отдельный раздел только для чтения в формате erofs;
- разметка диска сразу под обновления A/B: рядом лежит пустой второй слот
  для `/usr`;
- ядро — свежее из `trixie-backports` (не ниже 6.18.4).

Что сделано и что дальше — в [docs/](docs/). План работ — в репозитории
студии, `docs/plans/devuz-os/`.

## Версия mkosi

Используем **mkosi v27.1** — везде одну и ту же:

- в GitHub Actions — действие `systemd/mkosi@v27.1`;
- у себя — `pipx install git+https://github.com/systemd/mkosi.git@v27.1`.

## Как собрать у себя

Нужен Linux (лучше Debian 13 или Ubuntu 24.04+), свежий пакет
`debian-archive-keyring` (2025.x и новее, с ключами trixie), около 10 ГБ
места и доступ к `/dev/kvm` для запуска.

```sh
git clone https://github.com/egeg23/devuz-os
cd devuz-os
tools/prepare-packages.sh   # ядро из Release по kernel.lock + пакет без dracut
mkosi genkey                # свой ключ подписи verity (mkosi.key/mkosi.crt, в git не попадёт)
mkosi -f build
```

Без `gh` (GitHub CLI) скрипт возьмёт ядро из `trixie-backports` — какое там
есть сейчас; точная версия образа из Actions записана в `kernel.lock`.

Результат — в `mkosi.output/`: образ диска `devuz_<версия>.raw`, отдельно
UKI (`.efi`), разделы и манифест пакетов. Первая сборка долгая: mkosi
сначала собирает свой набор инструментов (tools tree) из Debian.

## Как запустить в виртуалке (QEMU)

Проще всего — через mkosi из папки репозитория, после сборки:

```sh
mkosi vm
```

Готовый образ из Actions (артефакт `devuz-image-…`) можно запустить и без
mkosi — нужны `qemu-system-x86_64` и прошивка UEFI (пакет `ovmf`):

```sh
unzstd devuz_*.raw.zst
cp /usr/share/OVMF/OVMF_VARS_4M.fd ./vars.fd
qemu-system-x86_64 -machine q35 -accel kvm -cpu host -m 2G -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
  -drive if=pflash,format=raw,file=./vars.fd \
  -drive if=virtio,format=raw,file=devuz_<версия>.raw \
  -nic user,model=virtio-net-pci
```

Появится экран входа с надписью «DevUz OS» и версией образа. Пользователей
для входа пока нет — это следующие недели.

VirtualBox — «если получится»: перевести образ
`VBoxManage convertfromraw devuz_<версия>.raw devuz.vdi` и включить EFI
в настройках машины.

## Тестовый образ и самопроверка

Боевой образ не содержит тестовых служб и не принимает учётные данные
systemd (`systemd.import_credentials=no`). Для проверки собирается
тестовый образ — профиль `test` (`mkosi.profiles/test/`): в нём служба
`devuz-test.service`, которая по учётным данным `devuz.test` запускает
самопроверку или тест обновления. Самопроверка печатает версии, состояние
`/usr`, root, Secure Boot и TPM, пишет `DEVUZ-SELFTEST OK` и выключает
машину. Так образ проверяется в Actions:

```sh
mkosi --profile=test -f build
mkosi --profile=test --console=native --credential=devuz.test=selftest vm
```

Тестовый образ коробкам не ставить.

## Размер диска

Root создаётся при первой загрузке на свободном месте того диска, где
лежит `/usr`. Сам образ занимает около 5,2 ГБ (ESP 1 ГБ и два слота `/usr`
по 2 ГБ), root — не меньше 1 ГБ: диск коробки нужен от 8 ГБ. Если места
нет, root не создастся и система не загрузится. Для запуска в QEMU
вручную увеличьте файл образа: `truncate -s 16G devuz_<версия>.raw`.

## Лицензия

LGPL-2.1-or-later, см. [LICENSE](LICENSE).
