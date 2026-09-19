import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("muting suppresses every timer alert and persists the preference", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const audio = vi.fn(function () {
    throw new Error("Audio unavailable");
  });
  vi.stubGlobal("AudioContext", audio);
  const sound = await import("../src/shared/lib/sound");
  expect(sound.isSoundEnabled()).toBe(true);
  sound.setSoundEnabled(false);
  sound.playClockWarning();
  sound.playClockExpired();
  sound.playClaimReady();
  expect(audio).not.toHaveBeenCalled();
  expect(storage.get("fourk.sound")).toBe("off");
  vi.resetModules();
  expect((await import("../src/shared/lib/sound")).isSoundEnabled()).toBe(false);
  sound.setSoundEnabled(true);
  sound.playClockWarning();
  expect(audio).toHaveBeenCalledOnce();
});

test("sound still mutes when storage is blocked", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Blocked");
    },
    setItem: () => {
      throw new Error("Blocked");
    },
  });
  const sound = await import("../src/shared/lib/sound");
  expect(sound.isSoundEnabled()).toBe(true);
  sound.setSoundEnabled(false);
  expect(sound.isSoundEnabled()).toBe(false);
});

test("sound controls notify subscribers and follow other tabs", async () => {
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  let stored = "on";
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value;
    },
  });
  const sound = await import("../src/shared/lib/sound");
  const changed = vi.fn();
  const unsubscribe = sound.subscribeToSound(changed);
  sound.setSoundEnabled(false);
  expect(changed).toHaveBeenCalledOnce();
  stored = "on";
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: "fourk.sound" });
  target.dispatchEvent(event);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(sound.isSoundEnabled()).toBe(true);
  unsubscribe();
  sound.setSoundEnabled(false);
  target.dispatchEvent(event);
  expect(changed).toHaveBeenCalledTimes(2);
});
