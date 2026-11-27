import { describe, expect, it } from "vitest";
import { ADMIN_TEXTS, capErrorText } from "../../api/workshop/texts.js";
import { APP_AI_PATH, appAiText, capsBody, fieldValue, parseSettings, saveResult, settingsResult, stateText, switchResult } from "./admin-view.js";

const settings = { aiBudgetUsd: 5, changeRequestsPerPerson: 5, buildsAtOnce: 15, stopped: false, appAiEnabled: false };

describe("admin view (ticket 3.12)", () => {
  it("reads the settings only in the API's shape", () => {
    expect(parseSettings(settings)).toEqual(settings);
    expect(parseSettings({ ...settings, stopped: "yes" })).toBeUndefined();
    expect(parseSettings({ ...settings, buildsAtOnce: "15" })).toBeUndefined();
    expect(parseSettings([])).toBeUndefined();
    expect(parseSettings(null)).toBeUndefined();
  });

  it("shows the budget with cents and the counts as whole numbers", () => {
    expect(fieldValue("aiBudgetUsd", { ...settings, aiBudgetUsd: 7.5 })).toBe("7.50");
    expect(fieldValue("buildsAtOnce", settings)).toBe("15");
  });

  it("sends numbers as typed and null for anything that is not a number, so the API names the field", () => {
    expect(capsBody({ aiBudgetUsd: " 7.5 ", changeRequestsPerPerson: "3", buildsAtOnce: "10" })).toEqual({ aiBudgetUsd: 7.5, changeRequestsPerPerson: 3, buildsAtOnce: 10 });
    expect(capsBody({ aiBudgetUsd: "", changeRequestsPerPerson: "three", buildsAtOnce: "Infinity" })).toEqual({ aiBudgetUsd: null, changeRequestsPerPerson: null, buildsAtOnce: null });
    // Out of range is the API's to refuse: the page sends it as typed.
    expect(capsBody({ aiBudgetUsd: "99", changeRequestsPerPerson: "2.5", buildsAtOnce: "0" })).toEqual({ aiBudgetUsd: 99, changeRequestsPerPerson: 2.5, buildsAtOnce: 0 });
  });

  it("reads GET /api/admin/settings: 404 hides the section, 401 signs out, anything else is an error", () => {
    expect(settingsResult({ status: 200, body: settings })).toEqual({ kind: "settings", settings });
    expect(settingsResult({ status: 404, body: { message: "Not found." } })).toEqual({ kind: "not-admin" });
    expect(settingsResult({ status: 401, body: null })).toEqual({ kind: "signed-out" });
    expect(settingsResult({ status: 0, body: null })).toEqual({ kind: "error", message: ADMIN_TEXTS.offline });
    expect(settingsResult({ status: 500, body: null })).toEqual({ kind: "error", message: ADMIN_TEXTS.readFailed });
    expect(settingsResult({ status: 200, body: {} })).toEqual({ kind: "error", message: ADMIN_TEXTS.readFailed });
  });

  it("reads a save: the settings as read back, or the API's 400 with the fields it names", () => {
    expect(saveResult({ status: 200, body: settings })).toEqual({ kind: "saved", settings, message: ADMIN_TEXTS.saved });
    expect(saveResult({ status: 400, body: { message: "Send aiBudgetUsd ...", invalid: ["buildsAtOnce", "nonsense", "aiBudgetUsd"] } })).toEqual({
      kind: "invalid",
      message: "Send aiBudgetUsd ...",
      invalid: ["aiBudgetUsd", "buildsAtOnce"],
    });
    expect(saveResult({ status: 400, body: null })).toEqual({ kind: "invalid", message: ADMIN_TEXTS.invalid, invalid: [] });
    expect(saveResult({ status: 404, body: null })).toEqual({ kind: "not-admin" });
    expect(saveResult({ status: 500, body: { message: "x" } })).toEqual({ kind: "error", message: ADMIN_TEXTS.saveFailed });
  });

  it("reads Stop and Resume: anything but a good 200 means read the settings again (3.5)", () => {
    expect(switchResult({ status: 200, body: { ...settings, stopped: true } })).toEqual({ kind: "switched", settings: { ...settings, stopped: true } });
    expect(switchResult({ status: 500, body: { message: "x" } })).toEqual({ kind: "reread" });
    expect(switchResult({ status: 0, body: null })).toEqual({ kind: "reread" });
    expect(switchResult({ status: 200, body: {} })).toEqual({ kind: "reread" });
    expect(switchResult({ status: 404, body: null })).toEqual({ kind: "not-admin" });
    expect(switchResult({ status: 401, body: null })).toEqual({ kind: "signed-out" });
  });

  it("words the state and the field errors from the API's ranges", () => {
    expect(stateText(true)).toMatch(/^Workshop paused/);
    expect(stateText(false)).toBe(ADMIN_TEXTS.workshopRunning);
    expect(capErrorText("aiBudgetUsd")).toBe("Enter an amount from $0 to $50.");
    expect(capErrorText("changeRequestsPerPerson")).toBe("Enter a whole number from 0 to 20.");
    expect(capErrorText("buildsAtOnce")).toBe("Enter a whole number from 1 to 30.");
  });
});

describe("admin view: the switch \"Apps may use AI\" (ticket 3.21)", () => {
  it("reads the switch from the settings, off unless the API says true", () => {
    expect(parseSettings({ ...settings, appAiEnabled: true })?.appAiEnabled).toBe(true);
    expect(parseSettings({ ...settings, appAiEnabled: "true" })?.appAiEnabled).toBe(false);
    const older: Record<string, unknown> = { ...settings };
    delete older["appAiEnabled"];
    expect(parseSettings(older)?.appAiEnabled).toBe(false);
  });

  it("puts to /api/admin/app-ai and reads its answer like Stop's: the settings, or read again", () => {
    expect(APP_AI_PATH).toBe("/api/admin/app-ai");
    expect(switchResult({ status: 200, body: { ...settings, appAiEnabled: true } })).toEqual({ kind: "switched", settings: { ...settings, appAiEnabled: true } });
    expect(switchResult({ status: 400, body: { message: "Send enabled: true or false, as JSON." } })).toEqual({ kind: "reread" });
    expect(switchResult({ status: 0, body: null })).toEqual({ kind: "reread" });
  });

  it("says on, off, or held off by the global Stop", () => {
    expect(appAiText({ appAiEnabled: true, stopped: false })).toBe(ADMIN_TEXTS.appAiOn);
    expect(appAiText({ appAiEnabled: false, stopped: false })).toBe(ADMIN_TEXTS.appAiOff);
    expect(appAiText({ appAiEnabled: false, stopped: true })).toBe(ADMIN_TEXTS.appAiOff);
    expect(appAiText({ appAiEnabled: true, stopped: true })).toBe(ADMIN_TEXTS.appAiStopped);
  });
});
