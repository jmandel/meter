import { expect, test } from "bun:test";

import { buildChromeArgs } from "./worker";

test("buildChromeArgs enables fake media devices for cloud Zoom joins", () => {
  const args = buildChromeArgs({
    cdpPort: 9222,
    chromeUserDataDir: "/tmp/meter-chrome-profile",
  });

  expect(args).toContain("--use-fake-device-for-media-stream");
  expect(args).toContain("--use-fake-ui-for-media-stream");
  expect(args).toContain("--auto-accept-this-tab-capture");
  expect(args).toContain("--auto-select-desktop-capture-source=Zoom");
});
