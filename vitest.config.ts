import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // .claude/worktrees/ holds other sessions' checkouts; their tests are not ours.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
