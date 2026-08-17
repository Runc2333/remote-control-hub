import { faComputer } from "@fortawesome/free-solid-svg-icons";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon.js";

describe("Icon", () => {
  it("renders an accessible inline svg", () => {
    const markup = renderToStaticMarkup(
      <Icon icon={faComputer} label="设备" />,
    );

    expect(markup).toContain("<svg");
    expect(markup).toContain('aria-label="设备"');
    expect(markup).not.toContain("<i");
  });
});
