// SPDX-License-Identifier: LGPL-2.1-or-later
// Проверка здоровья «Ядра» для podman (HealthCmd). Отдельный файл, а не
// «node -e "…"» в .container: quadlet снимает кавычки, и строка ломается.
"use strict";
fetch("http://127.0.0.1:8090/v1/health").then(
  (r) => process.exit(r.ok ? 0 : 1),
  () => process.exit(1),
);
