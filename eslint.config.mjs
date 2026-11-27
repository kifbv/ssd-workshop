// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["**/node_modules/", "**/cdk.out/", "**/dist/", "**/coverage/", ".claude/"]),
  eslint.configs.recommended,
  tseslint.configs.strict,
  {
    // App templates (ticket 2.3): classic browser scripts, no modules. The few browser globals they use are
    // declared here instead of adding the `globals` package; `workshopData` comes from workshop-data.js.
    files: ["templates/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        location: "readonly",
        history: "readonly",
        Element: "readonly",
        fetch: "readonly",
        // Ticket 3.19: photos and voice recordings in workshop-data.js.
        navigator: "readonly",
        crypto: "readonly",
        btoa: "readonly",
        Blob: "readonly",
        createImageBitmap: "readonly",
        OffscreenCanvas: "readonly",
        MediaRecorder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        // Ticket 3.28: workshop-data.js keeps old apps' sign-in elements hidden.
        MutationObserver: "readonly",
        workshopData: "readonly",
      },
    },
  },
);
