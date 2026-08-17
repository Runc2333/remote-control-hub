import { describe, expect, it } from "vitest";
import { isRequiredReleaseRequest } from "./release-request.js";

const RESOURCES = [{ url: "/assets/app.js" }, { url: "/index.html" }];

describe("isRequiredReleaseRequest", () => {
  it("requires navigations and declared static resources", () => {
    expect(
      isRequiredReleaseRequest(
        new URL("https://hub.example.com/"),
        "navigate",
        RESOURCES,
      ),
    ).toBe(true);
    expect(
      isRequiredReleaseRequest(
        new URL("https://hub.example.com/assets/app.js"),
        "cors",
        RESOURCES,
      ),
    ).toBe(true);
  });

  it("sends dynamic and undeclared requests to the network", () => {
    expect(
      isRequiredReleaseRequest(
        new URL("https://hub.example.com/healthz"),
        "cors",
        RESOURCES,
      ),
    ).toBe(false);
    expect(
      isRequiredReleaseRequest(
        new URL("https://hub.example.com/assets/app.js?refresh=1"),
        "cors",
        RESOURCES,
      ),
    ).toBe(false);
  });
});
