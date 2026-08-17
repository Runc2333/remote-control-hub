const CANDIDATE_CONTEXT_KEY = "rch-candidate-context";
const UPDATE_RETRY_AFTER_KEY = "rch-update-retry-after";
const WORKER_CHECKED_AT_KEY = "rch-worker-checked-at";
const WORKER_CHECK_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1_000;
const UPDATE_RETRY_DELAY_MILLISECONDS = 5 * 60 * 1_000;

type CandidateContext = {
  generation: number;
  nonce: string;
  releaseId: string;
};

let currentRegistration: ServiceWorkerRegistration | undefined;
let workerActivationNonce: string | undefined;
let reloadingForWorker = false;

const dispatchUpdate = (detail: unknown): void => {
  window.dispatchEvent(new CustomEvent("rch-update", { detail }));
};

const readCandidateContext = (): CandidateContext | undefined => {
  const serialized = sessionStorage.getItem(CANDIDATE_CONTEXT_KEY);
  if (serialized === null) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value === "object" &&
      value !== null &&
      "generation" in value &&
      typeof value.generation === "number" &&
      Number.isSafeInteger(value.generation) &&
      "nonce" in value &&
      typeof value.nonce === "string" &&
      "releaseId" in value &&
      typeof value.releaseId === "string"
    ) {
      return value as CandidateContext;
    }
  } catch {
    sessionStorage.removeItem(CANDIDATE_CONTEXT_KEY);
  }
  return undefined;
};

const writeCandidateContext = (context: CandidateContext): void => {
  sessionStorage.setItem(CANDIDATE_CONTEXT_KEY, JSON.stringify(context));
};

const requestWaitingWorkerVersion = (
  registration: ServiceWorkerRegistration,
): void => {
  registration.waiting?.postMessage({ type: "GET_WORKER_VERSION" });
};

const handleMessage = (data: unknown): void => {
  if (typeof data !== "object" || data === null || !("type" in data)) {
    return;
  }
  dispatchUpdate(data);
  if (
    data.type === "UPDATE_READY" &&
    "generation" in data &&
    typeof data.generation === "number" &&
    Number.isSafeInteger(data.generation) &&
    "releaseId" in data &&
    typeof data.releaseId === "string"
  ) {
    const context = {
      generation: data.generation,
      nonce: crypto.randomUUID(),
      releaseId: data.releaseId,
    } satisfies CandidateContext;
    writeCandidateContext(context);
    navigator.serviceWorker.controller?.postMessage({
      ...context,
      type: "VALIDATE_CANDIDATE",
    });
  } else if (
    data.type === "RELOAD_FOR_CANDIDATE" &&
    "generation" in data &&
    "nonce" in data &&
    "releaseId" in data
  ) {
    const context = readCandidateContext();
    if (
      context !== undefined &&
      data.generation === context.generation &&
      data.nonce === context.nonce &&
      data.releaseId === context.releaseId
    ) {
      window.location.reload();
    }
  } else if (
    data.type === "UPDATE_ACTIVATED" ||
    data.type === "UPDATE_CANCELLED" ||
    data.type === "UPDATE_FAILED"
  ) {
    sessionStorage.removeItem(CANDIDATE_CONTEXT_KEY);
  } else if (
    data.type === "WORKER_VERSION" &&
    "canActivate" in data &&
    data.canActivate === true &&
    "activationNonce" in data &&
    typeof data.activationNonce === "string" &&
    "workerVersion" in data &&
    typeof data.workerVersion === "string"
  ) {
    workerActivationNonce = data.activationNonce;
    dispatchUpdate({
      type: "WORKER_UPDATE_READY",
      workerVersion: data.workerVersion,
    });
  }
};

const scheduleCandidateTimeout = (): void => {
  const context = readCandidateContext();
  if (context === undefined) {
    return;
  }
  window.setTimeout(() => {
    const current = readCandidateContext();
    if (
      current?.generation === context.generation &&
      current.nonce === context.nonce &&
      current.releaseId === context.releaseId
    ) {
      navigator.serviceWorker.controller?.postMessage({
        ...context,
        type: "FAIL_CANDIDATE",
      });
      sessionStorage.removeItem(CANDIDATE_CONTEXT_KEY);
      dispatchUpdate({
        code: "candidate_startup_timeout",
        type: "UPDATE_FAILED",
      });
    }
  }, 15_000);
};

export const registerServiceWorker = async (): Promise<
  ServiceWorkerRegistration | undefined
> => {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    return undefined;
  }
  navigator.serviceWorker.addEventListener(
    "message",
    (event: MessageEvent<unknown>) => handleMessage(event.data),
  );
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("remote-control-hub-updates");
    channel.addEventListener("message", (event: MessageEvent<unknown>) =>
      handleMessage(event.data),
    );
  }
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!reloadingForWorker) {
      reloadingForWorker = true;
      window.location.reload();
    }
  });
  const registration = await navigator.serviceWorker.register("/sw.js", {
    type: "module",
    updateViaCache: "none",
  });
  currentRegistration = registration;
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed" && registration.waiting !== null) {
        requestWaitingWorkerVersion(registration);
      }
    });
  });
  requestWaitingWorkerVersion(registration);
  const checkedAt = Number.parseInt(
    localStorage.getItem(WORKER_CHECKED_AT_KEY) ?? "0",
    10,
  );
  if (
    !Number.isSafeInteger(checkedAt) ||
    Date.now() - checkedAt >= WORKER_CHECK_INTERVAL_MILLISECONDS
  ) {
    localStorage.setItem(WORKER_CHECKED_AT_KEY, Date.now().toString());
    await registration.update();
  }
  const candidateContext = readCandidateContext();
  scheduleCandidateTimeout();
  const retryAfter = Number.parseInt(
    localStorage.getItem(UPDATE_RETRY_AFTER_KEY) ?? "0",
    10,
  );
  if (
    candidateContext === undefined &&
    (!Number.isSafeInteger(retryAfter) || retryAfter <= Date.now())
  ) {
    const ready = await navigator.serviceWorker.ready;
    ready.active?.postMessage({ type: "START_UPDATE" });
  }
  return registration;
};

export const confirmCandidateStartup = (): void => {
  const context = readCandidateContext();
  if (context === undefined) {
    return;
  }
  navigator.serviceWorker.controller?.postMessage({
    ...context,
    type: "STARTUP_CONFIRMED",
  });
};

export const cancelAppUpdate = (): void => {
  sessionStorage.removeItem(CANDIDATE_CONTEXT_KEY);
  navigator.serviceWorker.controller?.postMessage({ type: "CANCEL_UPDATE" });
};

export const retryAppUpdate = (): void => {
  localStorage.removeItem(UPDATE_RETRY_AFTER_KEY);
  navigator.serviceWorker.controller?.postMessage({ type: "START_UPDATE" });
};

export const dismissAppUpdateFailure = (): void => {
  localStorage.setItem(
    UPDATE_RETRY_AFTER_KEY,
    (Date.now() + UPDATE_RETRY_DELAY_MILLISECONDS).toString(),
  );
};

export const activateWorkerUpdate = (): void => {
  if (
    workerActivationNonce === undefined ||
    currentRegistration?.waiting === null ||
    currentRegistration?.waiting === undefined
  ) {
    return;
  }
  currentRegistration.waiting.postMessage({
    nonce: workerActivationNonce,
    type: "ACTIVATE_WORKER",
  });
  workerActivationNonce = undefined;
};
