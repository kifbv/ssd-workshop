// Run in a child process by formats.test.ts (ticket 3.18 try 3), under a small heap (`--max-old-space-size`): does
// what the media API does with one hostile file (check it, measure a recording, remove metadata) and prints one JSON
// line with the time taken and the process's peak memory. Not bundled: no handler imports it.
import { hostileJpeg, hostileMp4, hostileWebm } from "./hostile.js";
import { inspectMedia, recordingSeconds, stripRecordingMetadata } from "./formats.js";

const which = process.argv[2];
const input = which === "webm" ? hostileWebm() : which === "mp4" ? hostileMp4() : hostileJpeg(which === "segments" ? "segments" : "restarts");
const rssBefore = process.memoryUsage().rss;
const started = performance.now();
const found = inspectMedia(input);
const result: Record<string, unknown> = { kind: found?.kind };
if (found?.kind === "jpeg") result["bytes"] = found.photo.length;
else if (found !== undefined) {
  result["seconds"] = recordingSeconds(input, found.kind);
  result["bytes"] = stripRecordingMetadata(input, found.kind).length;
}
result["ms"] = Math.round(performance.now() - started);
// maxRSS is in kilobytes.
result["peakGrowthMb"] = Math.round((process.resourceUsage().maxRSS * 1024 - rssBefore) / 2 ** 20);
result["inputBytes"] = input.length;
process.stdout.write(`${JSON.stringify(result)}\n`);
