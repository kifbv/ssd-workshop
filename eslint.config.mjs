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
        fetch: "readonly",
        workshopData: "readonly",
      },
    },
  },
);
