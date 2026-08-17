import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmCandidateStartup, registerServiceWorker } from "./register.js";

const CANDIDATE_CONTEXT_KEY = "rch-candidate-context";
const UPDATE_FAILURE_STORAGE_KEY = "rch-update-failure";
const WORKER_CHECKED_AT_KEY = "rch-worker-checked-at";

type StorageStub = Storage & {
  values: Map<string, string>;
};

const createStorage = (): StorageStub => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
    values,
  };
};

const setupBrowser = (
  candidate: boolean,
  controlled = true,
  href = "https://hub.example.com/",
) => {
  const activePostMessage = vi.fn();
  const controllerPostMessage = vi.fn();
  const dispatchEvent = vi.fn();
  const historyReplaceState = vi.fn();
  const reload = vi.fn();
  const replace = vi.fn();
  const setTimeout = vi.fn();
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  localStorage.setItem(WORKER_CHECKED_AT_KEY, Date.now().toString());
  if (candidate) {
    sessionStorage.setItem(
      CANDIDATE_CONTEXT_KEY,
      JSON.stringify({
        generation: 1,
        nonce: "candidate-nonce",
        releaseId: "candidate-release",
      }),
    );
  }
  const registration = {
    addEventListener: vi.fn(),
    installing: null,
    update: vi.fn(),
    waiting: null,
  };
  const serviceWorker = {
    addEventListener: vi.fn(),
    controller: controlled ? { postMessage: controllerPostMessage } : null,
    ready: Promise.resolve({ active: { postMessage: activePostMessage } }),
    register: vi.fn().mockResolvedValue(registration),
  };
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("navigator", {
    serviceWorker,
    userAgent: "test-browser",
  });
  vi.stubGlobal("sessionStorage", sessionStorage);
  vi.stubGlobal("window", {
    dispatchEvent,
    history: { replaceState: historyReplaceState, state: null },
    isSecureContext: true,
    location: { href, reload, replace },
    setTimeout,
  });
  return {
    activePostMessage,
    controllerPostMessage,
    dispatchEvent,
    historyReplaceState,
    reload,
    replace,
    serviceWorker,
    sessionStorage,
    setTimeout,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerServiceWorker", () => {
  it("does not restart an update while a candidate is starting", async () => {
    const { activePostMessage } = setupBrowser(true);

    await registerServiceWorker();

    expect(activePostMessage).not.toHaveBeenCalled();
  });

  it("checks for an app update when there is no candidate", async () => {
    const { activePostMessage } = setupBrowser(false);

    await registerServiceWorker();

    expect(activePostMessage).toHaveBeenCalledWith({ type: "START_UPDATE" });
  });

  it("does not reload when the first worker claims an uncontrolled page", async () => {
    const { reload, serviceWorker } = setupBrowser(false, false);

    await registerServiceWorker();
    const controllerChangeCall = serviceWorker.addEventListener.mock.calls.find(
      ([eventName]) => eventName === "controllerchange",
    );
    const controllerChange = controllerChangeCall?.[1];
    expect(controllerChange).toBeTypeOf("function");

    controllerChange?.();
    expect(reload).not.toHaveBeenCalled();

    controllerChange?.();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("navigates to the candidate with its nonce", async () => {
    const { replace, serviceWorker } = setupBrowser(true);

    await registerServiceWorker();
    const messageCall = serviceWorker.addEventListener.mock.calls.find(
      ([eventName]) => eventName === "message",
    );
    const listener = messageCall?.[1];
    expect(listener).toBeTypeOf("function");

    listener?.({
      data: {
        generation: 1,
        nonce: "candidate-nonce",
        releaseId: "candidate-release",
        type: "RELOAD_FOR_CANDIDATE",
      },
    });

    expect(replace).toHaveBeenCalledOnce();
    expect(String(replace.mock.calls[0]?.[0])).toContain(
      "rch-update-candidate=candidate-nonce",
    );
  });

  it("removes the candidate nonce from the visible URL", async () => {
    const { historyReplaceState } = setupBrowser(
      true,
      true,
      "https://hub.example.com/?rch-update-candidate=candidate-nonce",
    );

    await registerServiceWorker();

    expect(historyReplaceState).toHaveBeenCalledWith(
      null,
      "",
      "https://hub.example.com/",
    );
  });

  it("persists structured candidate startup timeout details", async () => {
    const { controllerPostMessage, dispatchEvent, sessionStorage, setTimeout } =
      setupBrowser(true);

    await registerServiceWorker();
    const timeoutCallback = setTimeout.mock.calls[0]?.[0];
    expect(timeoutCallback).toBeTypeOf("function");

    timeoutCallback?.();

    expect(controllerPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "candidate_startup_timeout",
        phase: "candidate_startup",
        type: "FAIL_CANDIDATE",
      }),
    );
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rch-update" }),
    );
    expect(sessionStorage.getItem(UPDATE_FAILURE_STORAGE_KEY)).not.toBeNull();
  });

  it("signals the startup shell after confirming a candidate", () => {
    const { controllerPostMessage, dispatchEvent } = setupBrowser(true);

    confirmCandidateStartup();
    confirmCandidateStartup();

    expect(controllerPostMessage).toHaveBeenCalledOnce();
    expect(controllerPostMessage).toHaveBeenCalledWith({
      generation: 1,
      nonce: "candidate-nonce",
      releaseId: "candidate-release",
      type: "STARTUP_CONFIRMED",
    });
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rch-candidate-startup-confirmed" }),
    );
  });
});
