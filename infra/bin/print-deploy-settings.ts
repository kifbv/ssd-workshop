#!/usr/bin/env node
// Prints the deploy workflow's settings as `key=value` lines for $GITHUB_OUTPUT,
// so infra/lib/config.ts stays the one place that holds the account and the role.
import { deploySettings, toGitHubOutput } from "../lib/deploy-settings.js";

process.stdout.write(toGitHubOutput(deploySettings()));
