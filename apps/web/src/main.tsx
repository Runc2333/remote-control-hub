import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";
import { registerServiceWorker } from "./pwa/register.js";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void registerServiceWorker().catch((error: unknown) => {
  window.dispatchEvent(
    new CustomEvent("rch-update", {
      detail: {
        code:
          error instanceof Error
            ? error.message
            : "service_worker_registration_failed",
        type: "UPDATE_FAILED",
      },
    }),
  );
});
