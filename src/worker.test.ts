import { expect, test } from "bun:test";

import { buildChromeArgs } from "./worker";

test("buildChromeArgs avoids fake media devices by default to preserve tab audio capture", () => {
  const args = buildChromeArgs({
    cdpPort: 9222,
    chromeUserDataDir: "/tmp/meter-chrome-profile",
  });

  expect(args).toContain("--use-fake-ui-for-media-stream");
  expect(args).not.toContain("--use-fake-device-for-media-stream");
  expect(args).toContain("--auto-accept-this-tab-capture");
  expect(args).toContain("--auto-select-desktop-capture-source=Zoom");
});

test("buildChromeArgs can opt into fake media devices for explicit experiments", () => {
  const args = buildChromeArgs({
    cdpPort: 9222,
    chromeUserDataDir: "/tmp/meter-chrome-profile",
    useFakeMediaDevice: true,
  });

  expect(args).toContain("--use-fake-device-for-media-stream");
});
