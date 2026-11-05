# SPDX-License-Identifier: LGPL-2.1-or-later
# Образ распознавания речи DevUz: whisper.cpp (MIT) — только whisper-server,
# без исходников, компилятора и моделей. Собирается в Actions из закреплённого
# коммита на закреплённой основе Debian 13 и подписывается нашим ключом, как
# остальные образы служб. Модель — отдельно, с подписанным манифестом.
# Процессор — с AVX2 (все коробки: Intel N100/N150, Ryzen); сборка под него,
# а не под машину сборки (GGML_NATIVE=OFF).
ARG BASE=mirror.gcr.io/library/debian@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
FROM ${BASE} AS build
ARG WHISPER_TAG=v1.9.5
ARG WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp /src \
 && test "$(git -C /src rev-parse HEAD)" = "$WHISPER_COMMIT"
RUN cmake -S /src -B /b -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
      -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF \
 && cmake --build /b -j"$(nproc)" --target whisper-server \
 && strip /b/bin/whisper-server

FROM ${BASE}
# opusdec — голосовые Telegram и WhatsApp (OGG/Opus); socat — сокет для «Ядра»;
# curl — проверка здоровья.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 opus-tools socat curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /b/bin/whisper-server /usr/local/bin/whisper-server
COPY ffmpeg /usr/local/bin/ffmpeg
COPY entry /usr/local/bin/devuz-stt
RUN chmod 755 /usr/local/bin/ffmpeg /usr/local/bin/devuz-stt
ENTRYPOINT ["/usr/local/bin/devuz-stt"]
