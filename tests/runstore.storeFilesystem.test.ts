import { describe, expect, it, vi } from "vitest";
import {
  ALLOW_NETWORK_STORE_ENV,
  assertStoreFilesystemSupported,
  classifyPathFilesystem,
  classifyStoreFilesystem,
  parseMountInfo,
} from "../src/runstore/storeFilesystem.js";
import { StoreOpenError } from "../src/runstore/sqlite/storeOpenError.js";

const SAMPLE_MOUNTINFO = `
21 28 0:19 / / rw,relatime - ext4 /dev/sda1 rw
22 21 0:20 / /mnt/nfs rw,relatime - nfs4 10.0.0.1:/export rw
23 21 0:21 / /mnt/cifs rw,relatime - cifs //server/share rw
24 21 0:22 / /mnt/9p rw,relatime - 9p tag rw
25 21 0:23 / /mnt/virtio rw,relatime - virtiofs tag rw
26 21 0:24 / /data rw,relatime - ext4 /dev/sdb1 rw
`.trim();

describe("parseMountInfo", () => {
  it("extracts mount points and fstypes", () => {
    const entries = parseMountInfo(SAMPLE_MOUNTINFO);
    expect(entries.find((e) => e.mountPoint === "/mnt/nfs")?.fsType).toBe(
      "nfs4",
    );
    expect(entries.find((e) => e.mountPoint === "/data")?.fsType).toBe("ext4");
  });
});

describe("classifyPathFilesystem", () => {
  it("picks the longest matching prefix", () => {
    const mounts = parseMountInfo(SAMPLE_MOUNTINFO);
    const match = classifyPathFilesystem("/mnt/nfs/stageflow", mounts);
    expect(match).toEqual({ fsType: "nfs4", mountPoint: "/mnt/nfs" });
  });
});

describe("classifyStoreFilesystem", () => {
  it("refuses nfs and cifs", () => {
    const nfs = classifyStoreFilesystem({
      homePath: "/mnt/nfs/home",
      platform: "linux",
      mountInfoContent: SAMPLE_MOUNTINFO,
      env: {},
    });
    expect(nfs.status).toBe("refused");
    expect(nfs.fsType).toBe("nfs4");

    const cifs = classifyStoreFilesystem({
      homePath: "/mnt/cifs/home",
      platform: "linux",
      mountInfoContent: SAMPLE_MOUNTINFO,
      env: {},
    });
    expect(cifs.status).toBe("refused");
    expect(cifs.fsType).toBe("cifs");
  });

  it("warns when network store escape hatch is set", () => {
    const result = classifyStoreFilesystem({
      homePath: "/mnt/nfs/home",
      platform: "linux",
      mountInfoContent: SAMPLE_MOUNTINFO,
      env: { [ALLOW_NETWORK_STORE_ENV]: "1" },
    });
    expect(result.status).toBe("warn");
    expect(result.fsType).toBe("nfs4");
  });

  it("warns on 9p and virtiofs", () => {
    expect(
      classifyStoreFilesystem({
        homePath: "/mnt/9p/data",
        platform: "linux",
        mountInfoContent: SAMPLE_MOUNTINFO,
        env: {},
      }).status,
    ).toBe("warn");
    expect(
      classifyStoreFilesystem({
        homePath: "/mnt/virtio/data",
        platform: "linux",
        mountInfoContent: SAMPLE_MOUNTINFO,
        env: {},
      }).status,
    ).toBe("warn");
  });

  it("accepts ext4", () => {
    const result = classifyStoreFilesystem({
      homePath: "/data/stageflow",
      platform: "linux",
      mountInfoContent: SAMPLE_MOUNTINFO,
      env: {},
    });
    expect(result.status).toBe("ok");
    expect(result.fsType).toBe("ext4");
  });

  it("skips detection on non-Linux", () => {
    const result = classifyStoreFilesystem({
      homePath: "/any",
      platform: "darwin",
      mountInfoContent: SAMPLE_MOUNTINFO,
      env: {},
    });
    expect(result.status).toBe("skipped");
    expect(result.fsType).toBeNull();
  });
});

describe("assertStoreFilesystemSupported", () => {
  it("throws store_unsupported_filesystem for nfs", () => {
    expect(() =>
      assertStoreFilesystemSupported("/mnt/nfs/home", {
        platform: "linux",
        mountInfoContent: SAMPLE_MOUNTINFO,
        env: {},
      }),
    ).toThrow(StoreOpenError);

    try {
      assertStoreFilesystemSupported("/mnt/nfs/home", {
        platform: "linux",
        mountInfoContent: SAMPLE_MOUNTINFO,
        env: {},
      });
    } catch (err) {
      expect((err as StoreOpenError).code).toBe("store_unsupported_filesystem");
      expect((err as StoreOpenError).message).toMatch(/nfs4/);
    }
  });

  it("warns instead of throwing for 9p", () => {
    const warn = vi.fn();
    const result = assertStoreFilesystemSupported("/mnt/9p/data", {
      platform: "linux",
      mountInfoContent: SAMPLE_MOUNTINFO,
      env: {},
      warn,
    });
    expect(result.status).toBe("warn");
    expect(warn).toHaveBeenCalledOnce();
  });
});
