const WORKER = self as unknown as ServiceWorkerGlobalScope;
const WORKER_VERSION = "1.0.0";
const WORKER_PROTOCOL_VERSION = 1;
const DATABASE_NAME = "remote-control-hub-releases";
const DATABASE_VERSION = 1;
const STORE_NAME = "state";
const ACTIVE_KEY = "active";
const CANDIDATE_KEY = "candidate";
const DOWNLOAD_LEASE_KEY = "download-lease";
const RELEASE_STATE_KEY = "release-state";
const MANIFEST_KEY_PREFIX = "manifest:";
const MAX_RESOURCES = 256;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_LEASE_MILLISECONDS = 75_000;
const VALIDATION_TIMEOUT_MILLISECONDS = 15_000;
const WORKER_INSTANCE_ID = crypto.randomUUID();
const UPDATE_CHANNEL =
  typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel("remote-control-hub-updates");
let updateAbortController: AbortController | undefined;
const WORKER_ACTIVATION_NONCES = new Map<string, string>();

type ReleaseResource = {
  bytes: number;
  sha256: string;
  url: string;
};

type ReleaseManifest = {
  apiCompatibility: { maximum: string; minimum: string };
  builtAt: string;
  releaseId: string;
  resources: ReleaseResource[];
  totalBytes: number;
  version: string;
  workerCompatibility: { maximum: number; minimum: number };
};

type ReleasePointer = {
  generation: number;
  releaseId: string;
};

type CandidatePointer = ReleasePointer & {
  clientId?: string;
  expectedResourceCount: number;
  nonce?: string;
  validationExpiresAt?: number;
  validationSourceClientId?: string;
  version: string;
};

type DownloadLease = {
  expiresAt: number;
  generation: number;
  ownerId: string;
};

type ReleaseState = {
  downloadedBytes: number;
  generation: number;
  releaseId: string;
  status: "active" | "downloading" | "failed" | "ready" | "validating";
  totalBytes: number;
  updatedAt: string;
  version: string;
};

type MetaVersion = {
  apiVersion: string;
  minimumWebRelease: string;
  workerProtocolVersion: number;
};

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error("indexeddb_open_failed"));
    request.onsuccess = () => resolve(request.result);
  });

const readState = async <Value>(key: string): Promise<Value | undefined> => {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onerror = () =>
      reject(request.error ?? new Error("indexeddb_read_failed"));
    request.onsuccess = () => resolve(request.result as Value | undefined);
    transaction.oncomplete = () => database.close();
  });
};

const writeState = async (
  entries: ReadonlyArray<readonly [string, unknown]>,
): Promise<void> => {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const [key, value] of entries) {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.put(value, key);
      }
    }
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("indexeddb_write_failed"));
    transaction.oncomplete = () => resolve();
  });
  database.close();
};

const bytesToHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

const acquireDownloadLease = async (): Promise<DownloadLease | undefined> => {
  const database = await openDatabase();
  let acquired: DownloadLease | undefined;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(DOWNLOAD_LEASE_KEY);
    request.onsuccess = () => {
      const existing = request.result as DownloadLease | undefined;
      const now = Date.now();
      if (existing !== undefined && existing.expiresAt > now) {
        return;
      }
      acquired = {
        expiresAt: now + DOWNLOAD_LEASE_MILLISECONDS,
        generation: (existing?.generation ?? 0) + 1,
        ownerId: WORKER_INSTANCE_ID,
      };
      store.put(acquired, DOWNLOAD_LEASE_KEY);
    };
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("download_lease_failed"));
    transaction.oncomplete = () => resolve();
  });
  database.close();
  return acquired;
};

const renewDownloadLease = async (lease: DownloadLease): Promise<void> => {
  const current = await readState<DownloadLease>(DOWNLOAD_LEASE_KEY);
  if (
    current?.generation !== lease.generation ||
    current.ownerId !== lease.ownerId
  ) {
    throw new Error("download_lease_lost");
  }
  lease.expiresAt = Date.now() + DOWNLOAD_LEASE_MILLISECONDS;
  await writeState([[DOWNLOAD_LEASE_KEY, lease]]);
};

const releaseDownloadLease = async (lease: DownloadLease): Promise<void> => {
  const current = await readState<DownloadLease>(DOWNLOAD_LEASE_KEY);
  if (
    current?.generation === lease.generation &&
    current.ownerId === lease.ownerId
  ) {
    await writeState([[DOWNLOAD_LEASE_KEY, undefined]]);
  }
};

const validateManifest = (value: unknown): ReleaseManifest => {
  if (typeof value !== "object" || value === null) {
    throw new Error("release_manifest_invalid");
  }
  const manifest = value as Partial<ReleaseManifest>;
  if (
    typeof manifest.releaseId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.releaseId) ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0 ||
    typeof manifest.builtAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.builtAt)) ||
    typeof manifest.totalBytes !== "number" ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes <= 0 ||
    !Array.isArray(manifest.resources) ||
    manifest.resources.length === 0 ||
    manifest.resources.length > MAX_RESOURCES ||
    manifest.totalBytes > MAX_RELEASE_BYTES ||
    manifest.apiCompatibility === undefined ||
    manifest.apiCompatibility.minimum !== "v1" ||
    manifest.apiCompatibility.maximum !== "v1" ||
    manifest.workerCompatibility === undefined ||
    typeof manifest.workerCompatibility.minimum !== "number" ||
    typeof manifest.workerCompatibility.maximum !== "number" ||
    manifest.workerCompatibility.minimum > WORKER_PROTOCOL_VERSION ||
    manifest.workerCompatibility.maximum < WORKER_PROTOCOL_VERSION
  ) {
    throw new Error("release_manifest_invalid");
  }
  const resourceUrls = new Set<string>();
  let calculatedTotalBytes = 0;
  const scopePath = new URL(WORKER.registration.scope).pathname;
  for (const resource of manifest.resources) {
    const url = new URL(resource.url, WORKER.location.origin);
    if (
      url.origin !== WORKER.location.origin ||
      !url.pathname.startsWith(scopePath) ||
      url.href !== new URL(url.pathname, WORKER.location.origin).href ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !Number.isSafeInteger(resource.bytes) ||
      resource.bytes <= 0 ||
      resource.bytes > MAX_RESOURCE_BYTES ||
      !/^[a-f0-9]{64}$/u.test(resource.sha256) ||
      resourceUrls.has(url.pathname)
    ) {
      throw new Error("release_resource_invalid");
    }
    resourceUrls.add(url.pathname);
    calculatedTotalBytes += resource.bytes;
  }
  if (calculatedTotalBytes !== manifest.totalBytes) {
    throw new Error("release_total_size_mismatch");
  }
  return manifest as ReleaseManifest;
};

const parseVersion = (value: string): readonly [number, number, number] => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (match === null) {
    throw new Error("release_version_invalid");
  }
  const version = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ] as const;
  if (version.some((part) => !Number.isSafeInteger(part))) {
    throw new Error("release_version_invalid");
  }
  return version;
};

const compareVersions = (left: string, right: string): number => {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) {
      throw new Error("release_version_invalid");
    }
    const difference = leftPart - rightPart;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const assertApiCompatibility = async (
  manifest: ReleaseManifest,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await fetch("/api/v1/meta/version", {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    ...(signal === undefined ? {} : { signal }),
  });
  if (
    response.status !== 200 ||
    response.redirected ||
    response.type === "opaque"
  ) {
    throw new Error("api_version_unavailable");
  }
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null) {
    throw new Error("api_version_invalid");
  }
  const meta = value as Partial<MetaVersion>;
  if (
    typeof meta.apiVersion !== "string" ||
    meta.apiVersion < manifest.apiCompatibility.minimum ||
    meta.apiVersion > manifest.apiCompatibility.maximum ||
    meta.workerProtocolVersion !== WORKER_PROTOCOL_VERSION ||
    typeof meta.minimumWebRelease !== "string" ||
    compareVersions(manifest.version, meta.minimumWebRelease) < 0
  ) {
    throw new Error("release_incompatible");
  }
};

const readResponseBody = async (
  response: Response,
  expectedBytes: number,
  signal: AbortSignal,
  onProgress: (resourceBytes: number) => Promise<void>,
): Promise<ArrayBuffer> => {
  if (response.body === null) {
    throw new Error("release_resource_body_missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel(signal.reason);
      throw new Error(
        typeof signal.reason === "string" ? signal.reason : "update_cancelled",
      );
    }
    const result = await reader.read();
    if (result.done) {
      break;
    }
    receivedBytes += result.value.byteLength;
    if (receivedBytes > expectedBytes) {
      await reader.cancel("release_resource_size_mismatch");
      throw new Error("release_resource_size_mismatch");
    }
    chunks.push(result.value);
    await onProgress(receivedBytes);
  }
  if (receivedBytes !== expectedBytes) {
    throw new Error("release_resource_size_mismatch");
  }
  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
};

const releaseState = (
  manifest: ReleaseManifest,
  generation: number,
  status: ReleaseState["status"],
  downloadedBytes: number,
): ReleaseState => ({
  downloadedBytes,
  generation,
  releaseId: manifest.releaseId,
  status,
  totalBytes: manifest.totalBytes,
  updatedAt: new Date().toISOString(),
  version: manifest.version,
});

const notifyClients = async (message: unknown): Promise<void> => {
  if (UPDATE_CHANNEL !== undefined) {
    UPDATE_CHANNEL.postMessage(message);
    return;
  }
  const clients = await WORKER.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  for (const client of clients) {
    client.postMessage(message);
  }
};

const downloadCandidate = async (): Promise<void> => {
  if (updateAbortController !== undefined) {
    return;
  }
  const lease = await acquireDownloadLease();
  if (lease === undefined) {
    return;
  }
  updateAbortController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(60_000);
  const signal = AbortSignal.any([updateAbortController.signal, timeoutSignal]);
  let cacheName: string | undefined;
  let manifest: ReleaseManifest | undefined;
  try {
    const manifestResponse = await fetch("/app-version.json", {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
    if (
      manifestResponse.status !== 200 ||
      manifestResponse.redirected ||
      manifestResponse.type === "opaque" ||
      !manifestResponse.headers.get("content-type")?.includes("json")
    ) {
      throw new Error("release_manifest_unavailable");
    }
    manifest = validateManifest(await manifestResponse.json());
    const targetManifest = manifest;
    const active = await readState<ReleasePointer>(ACTIVE_KEY);
    if (active?.releaseId === manifest.releaseId) {
      await notifyClients({
        releaseId: manifest.releaseId,
        type: "UPDATE_CURRENT",
        version: manifest.version,
      });
      return;
    }
    await assertApiCompatibility(manifest, signal);
    const generation = lease.generation;
    cacheName = `release-${manifest.releaseId}`;
    await caches.delete(cacheName);
    const cache = await caches.open(cacheName);
    let downloadedBytes = 0;
    await writeState([
      [
        RELEASE_STATE_KEY,
        releaseState(manifest, generation, "downloading", downloadedBytes),
      ],
    ]);
    await notifyClients({
      downloadedBytes,
      releaseId: manifest.releaseId,
      resourceCount: manifest.resources.length,
      resourceIndex: 0,
      totalBytes: manifest.totalBytes,
      type: "UPDATE_PROGRESS",
      version: manifest.version,
    });
    for (const [index, resource] of manifest.resources.entries()) {
      const response = await fetch(resource.url, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal,
      });
      if (
        response.status !== 200 ||
        response.type === "opaque" ||
        response.redirected ||
        new URL(response.url).origin !== WORKER.location.origin
      ) {
        throw new Error("release_resource_unavailable");
      }
      const previousBytes = downloadedBytes;
      const body = await readResponseBody(
        response,
        resource.bytes,
        signal,
        async (resourceBytes) => {
          const currentBytes = previousBytes + resourceBytes;
          await notifyClients({
            downloadedBytes: currentBytes,
            releaseId: targetManifest.releaseId,
            resourceCount: targetManifest.resources.length,
            resourceIndex: index + 1,
            totalBytes: targetManifest.totalBytes,
            type: "UPDATE_PROGRESS",
            version: targetManifest.version,
          });
        },
      );
      const digest = bytesToHex(await crypto.subtle.digest("SHA-256", body));
      if (digest !== resource.sha256) {
        throw new Error("release_resource_digest_mismatch");
      }
      const headers = new Headers();
      const contentType = response.headers.get("content-type");
      if (contentType !== null) {
        headers.set("content-type", contentType);
      }
      headers.set("content-length", resource.bytes.toString());
      await cache.put(
        resource.url,
        new Response(body, { headers, status: 200 }),
      );
      downloadedBytes += body.byteLength;
      await renewDownloadLease(lease);
      await writeState([
        [
          RELEASE_STATE_KEY,
          releaseState(manifest, generation, "downloading", downloadedBytes),
        ],
      ]);
    }
    await writeState([
      [`${MANIFEST_KEY_PREFIX}${manifest.releaseId}`, manifest],
      [
        CANDIDATE_KEY,
        {
          expectedResourceCount: manifest.resources.length,
          generation,
          releaseId: manifest.releaseId,
          version: manifest.version,
        } satisfies CandidatePointer,
      ],
      [
        RELEASE_STATE_KEY,
        releaseState(manifest, generation, "ready", downloadedBytes),
      ],
    ]);
    await notifyClients({
      generation,
      releaseId: manifest.releaseId,
      type: "UPDATE_READY",
      version: manifest.version,
    });
  } catch (error: unknown) {
    if (cacheName !== undefined) {
      await caches.delete(cacheName);
    }
    const code = error instanceof Error ? error.message : "update_failed";
    await writeState([
      [CANDIDATE_KEY, undefined],
      ...(manifest === undefined
        ? []
        : [
            [
              RELEASE_STATE_KEY,
              releaseState(manifest, lease.generation, "failed", 0),
            ] as const,
            [`${MANIFEST_KEY_PREFIX}${manifest.releaseId}`, undefined] as const,
          ]),
    ]);
    await notifyClients(
      code === "update_cancelled"
        ? { type: "UPDATE_CANCELLED" }
        : { code, type: "UPDATE_FAILED" },
    );
  } finally {
    updateAbortController = undefined;
    await releaseDownloadLease(lease);
  }
};

const promoteCandidate = async (
  clientId: string,
  generation: number,
  releaseId: string,
  nonce: string,
): Promise<void> => {
  const candidate = await readState<CandidatePointer>(CANDIDATE_KEY);
  if (
    candidate === undefined ||
    candidate.clientId !== clientId ||
    candidate.generation !== generation ||
    candidate.releaseId !== releaseId ||
    candidate.nonce !== nonce
  ) {
    return;
  }
  if (
    candidate.validationExpiresAt === undefined ||
    candidate.validationExpiresAt < Date.now()
  ) {
    await failCandidate("candidate_startup_timeout");
    return;
  }
  const manifest = await readState<ReleaseManifest>(
    `${MANIFEST_KEY_PREFIX}${candidate.releaseId}`,
  );
  if (manifest === undefined) {
    throw new Error("candidate_manifest_missing");
  }
  await assertApiCompatibility(manifest);
  const cache = await caches.open(`release-${candidate.releaseId}`);
  if ((await cache.keys()).length !== candidate.expectedResourceCount) {
    throw new Error("candidate_cache_missing");
  }
  await writeState([
    [
      ACTIVE_KEY,
      {
        generation: candidate.generation,
        releaseId: candidate.releaseId,
      } satisfies ReleasePointer,
    ],
    [CANDIDATE_KEY, undefined],
    [
      RELEASE_STATE_KEY,
      releaseState(
        manifest,
        candidate.generation,
        "active",
        manifest.totalBytes,
      ),
    ],
  ]);
  await notifyClients({
    releaseId: candidate.releaseId,
    type: "UPDATE_ACTIVATED",
  });
};

const failCandidate = async (code: string): Promise<void> => {
  const candidate = await readState<CandidatePointer>(CANDIDATE_KEY);
  if (candidate !== undefined) {
    await caches.delete(`release-${candidate.releaseId}`);
    const manifest = await readState<ReleaseManifest>(
      `${MANIFEST_KEY_PREFIX}${candidate.releaseId}`,
    );
    await writeState([
      [CANDIDATE_KEY, undefined],
      [`${MANIFEST_KEY_PREFIX}${candidate.releaseId}`, undefined],
      ...(manifest === undefined
        ? []
        : [
            [
              RELEASE_STATE_KEY,
              releaseState(manifest, candidate.generation, "failed", 0),
            ] as const,
          ]),
    ]);
  }
  await notifyClients({ code, type: "UPDATE_FAILED" });
};

WORKER.addEventListener("install", () => undefined);

WORKER.addEventListener("activate", (event) => {
  event.waitUntil(WORKER.clients.claim());
});

WORKER.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    requestUrl.origin !== WORKER.location.origin ||
    requestUrl.pathname.startsWith("/api/")
  ) {
    return;
  }
  event.respondWith(
    (async () => {
      const candidate = await readState<CandidatePointer>(CANDIDATE_KEY);
      if (
        event.request.mode === "navigate" &&
        candidate?.validationSourceClientId === event.clientId &&
        candidate.validationExpiresAt !== undefined &&
        candidate.validationExpiresAt >= Date.now() &&
        event.resultingClientId.length > 0
      ) {
        const candidateCache = await caches.open(
          `release-${candidate.releaseId}`,
        );
        const candidateResponse =
          (await candidateCache.match(event.request)) ??
          (await candidateCache.match("/index.html"));
        if (candidateResponse !== undefined) {
          const candidateWithoutSource: CandidatePointer = { ...candidate };
          delete candidateWithoutSource.validationSourceClientId;
          await writeState([
            [
              CANDIDATE_KEY,
              {
                ...candidateWithoutSource,
                clientId: event.resultingClientId,
              } satisfies CandidatePointer,
            ],
          ]);
          return candidateResponse;
        }
      }
      if (
        candidate?.clientId === event.clientId &&
        candidate.validationExpiresAt !== undefined &&
        candidate.validationExpiresAt >= Date.now()
      ) {
        const candidateCache = await caches.open(
          `release-${candidate.releaseId}`,
        );
        const candidateResponse =
          (await candidateCache.match(event.request)) ??
          (event.request.mode === "navigate"
            ? await candidateCache.match("/index.html")
            : undefined);
        if (candidateResponse !== undefined) {
          return candidateResponse;
        }
        await failCandidate("candidate_resource_missing");
        return new Response("Candidate resource unavailable", {
          status: 503,
        });
      }
      const active = await readState<ReleasePointer>(ACTIVE_KEY);
      if (active !== undefined) {
        const cache = await caches.open(`release-${active.releaseId}`);
        const cached =
          (await cache.match(event.request)) ??
          (event.request.mode === "navigate"
            ? await cache.match("/index.html")
            : undefined);
        if (cached !== undefined) {
          return cached;
        }
      }
      return fetch(event.request);
    })(),
  );
});

WORKER.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || !("type" in data)) {
    return;
  }
  const sourceId =
    event.source !== null &&
    "id" in event.source &&
    typeof event.source.id === "string"
      ? event.source.id
      : undefined;
  if (data.type === "GET_WORKER_VERSION") {
    event.waitUntil(
      (async () => {
        const candidate = await readState<CandidatePointer>(CANDIDATE_KEY);
        const active = await readState<ReleasePointer>(ACTIVE_KEY);
        const activeManifest =
          active === undefined
            ? undefined
            : await readState<ReleaseManifest>(
                `${MANIFEST_KEY_PREFIX}${active.releaseId}`,
              );
        const lease = await readState<DownloadLease>(DOWNLOAD_LEASE_KEY);
        const activeCompatible =
          active === undefined ||
          (activeManifest !== undefined &&
            activeManifest.workerCompatibility.minimum <=
              WORKER_PROTOCOL_VERSION &&
            activeManifest.workerCompatibility.maximum >=
              WORKER_PROTOCOL_VERSION);
        const canActivate =
          sourceId !== undefined &&
          candidate === undefined &&
          (lease === undefined || lease.expiresAt <= Date.now()) &&
          activeCompatible;
        const activationNonce = canActivate ? crypto.randomUUID() : undefined;
        if (sourceId !== undefined && activationNonce !== undefined) {
          WORKER_ACTIVATION_NONCES.set(sourceId, activationNonce);
        }
        event.source?.postMessage({
          activationNonce,
          canActivate,
          protocolVersion: WORKER_PROTOCOL_VERSION,
          type: "WORKER_VERSION",
          workerVersion: WORKER_VERSION,
        });
      })(),
    );
  } else if (data.type === "ACTIVATE_WORKER") {
    if (
      sourceId !== undefined &&
      "nonce" in data &&
      typeof data.nonce === "string" &&
      data.nonce === WORKER_ACTIVATION_NONCES.get(sourceId)
    ) {
      WORKER_ACTIVATION_NONCES.delete(sourceId);
      event.waitUntil(WORKER.skipWaiting());
    }
  } else if (data.type === "START_UPDATE") {
    event.waitUntil(downloadCandidate());
  } else if (data.type === "CANCEL_UPDATE") {
    updateAbortController?.abort("update_cancelled");
  } else if (
    data.type === "VALIDATE_CANDIDATE" &&
    sourceId !== undefined &&
    "generation" in data &&
    typeof data.generation === "number" &&
    "releaseId" in data &&
    typeof data.releaseId === "string" &&
    "nonce" in data &&
    typeof data.nonce === "string"
  ) {
    const generation = data.generation;
    const releaseId = data.releaseId;
    const nonce = data.nonce;
    event.waitUntil(
      (async () => {
        const candidate = await readState<CandidatePointer>(CANDIDATE_KEY);
        if (
          candidate === undefined ||
          candidate.generation !== generation ||
          candidate.releaseId !== releaseId ||
          (candidate.validationSourceClientId !== undefined &&
            candidate.validationSourceClientId !== sourceId &&
            candidate.validationExpiresAt !== undefined &&
            candidate.validationExpiresAt >= Date.now())
        ) {
          return;
        }
        const manifest = await readState<ReleaseManifest>(
          `${MANIFEST_KEY_PREFIX}${candidate.releaseId}`,
        );
        if (manifest === undefined) {
          throw new Error("candidate_manifest_missing");
        }
        await writeState([
          [
            CANDIDATE_KEY,
            {
              ...candidate,
              nonce,
              validationExpiresAt: Date.now() + VALIDATION_TIMEOUT_MILLISECONDS,
              validationSourceClientId: sourceId,
            } satisfies CandidatePointer,
          ],
          [
            RELEASE_STATE_KEY,
            releaseState(
              manifest,
              candidate.generation,
              "validating",
              manifest.totalBytes,
            ),
          ],
        ]);
        event.source?.postMessage({
          generation,
          nonce,
          releaseId,
          type: "RELOAD_FOR_CANDIDATE",
        });
      })().catch(async (error: unknown) => {
        await failCandidate(
          error instanceof Error
            ? error.message
            : "candidate_validation_failed",
        );
      }),
    );
  } else if (
    data.type === "FAIL_CANDIDATE" &&
    sourceId !== undefined &&
    "generation" in data &&
    typeof data.generation === "number" &&
    "releaseId" in data &&
    typeof data.releaseId === "string" &&
    "nonce" in data &&
    typeof data.nonce === "string"
  ) {
    event.waitUntil(
      (async () => {
        const candidate = await readState<CandidatePointer>(CANDIDATE_KEY);
        if (
          candidate?.clientId === sourceId &&
          candidate.generation === data.generation &&
          candidate.releaseId === data.releaseId &&
          candidate.nonce === data.nonce
        ) {
          await failCandidate("candidate_startup_timeout");
        }
      })(),
    );
  } else if (
    data.type === "STARTUP_CONFIRMED" &&
    sourceId !== undefined &&
    "generation" in data &&
    typeof data.generation === "number" &&
    "releaseId" in data &&
    typeof data.releaseId === "string" &&
    "nonce" in data &&
    typeof data.nonce === "string"
  ) {
    event.waitUntil(
      promoteCandidate(
        sourceId,
        data.generation,
        data.releaseId,
        data.nonce,
      ).catch(async (error: unknown) => {
        await failCandidate(
          error instanceof Error ? error.message : "candidate_startup_failed",
        );
      }),
    );
  }
});
