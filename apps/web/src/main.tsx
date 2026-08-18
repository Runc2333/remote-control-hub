import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";
import { registerServiceWorker } from "./pwa/register.js";
import {
  createUpdateFailure,
  UPDATE_FAILURE_STORAGE_KEY,
} from "./pwa/update-failure.js";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD) {
  void registerServiceWorker().catch((error: unknown) => {
    const failure = createUpdateFailure(error, {
      code:
        error instanceof Error
          ? error.message
          : "service_worker_registration_failed",
      phase: "worker_registration",
      userAgent: navigator.userAgent,
    });
    sessionStorage.setItem(UPDATE_FAILURE_STORAGE_KEY, JSON.stringify(failure));
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("rch-update", {
          detail: {
            ...failure,
            type: "UPDATE_FAILED",
          },
        }),
      );
    }, 0);
  });
}
