#!/usr/bin/env node
import { buildApp } from "../lib/app.js";

// The CDK CLI sets CDK_OUTDIR, so the app synthesizes itself when this script exits.
buildApp();
