import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./register.js";

const CANDIDATE_CONTEXT_KEY = "rch-candidate-context";
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

const setupBrowser = (candidate: boolean, controlled = true) => {
  const activePostMessage = vi.fn();
  const controllerPostMessage = vi.fn();
  const reload = vi.fn();
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
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("sessionStorage", sessionStorage);
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn(),
    isSecureContext: true,
    location: { reload },
    setTimeout: vi.fn(),
  });
  return { activePostMessage, reload, serviceWorker };
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
});
