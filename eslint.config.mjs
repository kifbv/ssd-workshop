// @ts-check
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["**/node_modules/", "**/cdk.out/", "**/dist/", "**/coverage/", ".claude/"]),
  eslint.configs.recommended,
  tseslint.configs.strict,
);
