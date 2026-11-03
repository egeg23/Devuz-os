// SPDX-License-Identifier: LGPL-2.1-or-later
"use strict";
require("node:http").get({ host: "127.0.0.1", port: Number(process.env.OFFICE_PORT || 8100), path: "/api/health", timeout: 3000 },
  (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on("error", () => process.exit(1));
