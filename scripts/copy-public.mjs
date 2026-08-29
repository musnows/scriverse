import { cpSync } from "node:fs";

cpSync(new URL("../src/public/", import.meta.url), new URL("../dist/public/", import.meta.url), { recursive: true });
cpSync(new URL("../src/skills/", import.meta.url), new URL("../dist/skills/", import.meta.url), { recursive: true });
cpSync(new URL("../node_modules/vditor/dist/", import.meta.url), new URL("../dist/public/vendor/vditor/dist/", import.meta.url), { recursive: true });
