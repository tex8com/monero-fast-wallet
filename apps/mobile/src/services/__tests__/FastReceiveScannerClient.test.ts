import {
  checkFastReceiveWatchRegistration,
  checkFastReceiveKeyImages,
  parseKeyImageStatusResponse,
  parseWatchStatusResponse,
  verifyFastReceiveScannerCapability,
  type ScannerFetch,
} from "../FastReceiveScannerClient";

describe("FastReceiveScannerClient", () => {
  it("verifies the public scanner capability before registration", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    })) as ScannerFetch & jest.Mock;

    await expect(
      verifyFastReceiveScannerCapability("https://xmr.tex8.com/", fetchImpl),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledWith("https://xmr.tex8.com/healthz", {
      method: "GET",
      headers: { accept: "application/json" },
    });
  });

  it("does not accept an unrelated server as a Fast Receive scanner", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false }),
    })) as ScannerFetch & jest.Mock;

    await expect(
      verifyFastReceiveScannerCapability("https://example.invalid", fetchImpl),
    ).rejects.toThrow("not a Fast Receive scanner");
  });

  it("posts key images to the scanner with bearer auth", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          identity_id: "fast-receive-0",
          items: [
            {
              key_image: "A".repeat(64),
              status: "spent",
              checked_height: 123,
            },
          ],
        }),
    })) as ScannerFetch & jest.Mock;

    const result = await checkFastReceiveKeyImages(
      {
        scannerUrl: "https://xmr.tex8.com/",
        scannerAuthToken: "secret-token",
        identityId: "fast-receive-0",
        keyImages: ["A".repeat(64)],
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://xmr.tex8.com/v1/fast-receive/key-images/status",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-token",
        },
        body: JSON.stringify({
          identity_id: "fast-receive-0",
          key_images: ["a".repeat(64)],
        }),
      },
    );
    expect(result).toEqual({
      identityId: "fast-receive-0",
      items: [
        {
          keyImage: "a".repeat(64),
          status: "spent",
          checkedHeight: 123,
        },
      ],
    });
  });

  it("rejects invalid key images before calling the scanner", async () => {
    const fetchImpl = jest.fn() as ScannerFetch & jest.Mock;

    await expect(
      checkFastReceiveKeyImages(
        {
          scannerUrl: "https://xmr.tex8.com",
          identityId: "fast-receive-0",
          keyImages: ["not-a-key-image"],
        },
        fetchImpl,
      ),
    ).rejects.toThrow("64-character hex");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks whether a watch is registered on the scanner", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          identity_id: "fast-receive-0",
          status: "enabled",
          scanner_status: "enabled",
          network: "mainnet",
          restore_height: 42,
          last_scanned_height: 100,
          notifications_enabled: true,
        }),
    })) as ScannerFetch & jest.Mock;

    const result = await checkFastReceiveWatchRegistration(
      {
        scannerUrl: "https://xmr.tex8.com/",
        scannerAuthToken: "secret-token",
        identityId: "fast-receive-0",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://xmr.tex8.com/v1/fast-receive/watch/fast-receive-0",
      {
        method: "GET",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-token",
        },
      },
    );
    expect(result).toEqual({
      identityId: "fast-receive-0",
      registered: true,
      scannerStatus: "enabled",
      notificationsEnabled: true,
      network: "mainnet",
      restoreHeight: 42,
      lastScannedHeight: 100,
    });
  });

  it("treats missing watch registration as a normal scanner state", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: "not found" }),
    })) as ScannerFetch & jest.Mock;

    await expect(
      checkFastReceiveWatchRegistration(
        {
          scannerUrl: "https://xmr.tex8.com",
          identityId: "fast-receive-0",
        },
        fetchImpl,
      ),
    ).resolves.toEqual({
      identityId: "fast-receive-0",
      registered: false,
      scannerStatus: "missing",
      notificationsEnabled: false,
    });
  });

  it("rejects mismatched scanner responses", () => {
    expect(() =>
      parseKeyImageStatusResponse(
        JSON.stringify({
          identity_id: "other",
          items: [],
        }),
        "fast-receive-0",
        [],
      ),
    ).toThrow("mismatched identity");

    expect(() =>
      parseWatchStatusResponse(
        JSON.stringify({
          identity_id: "other",
          status: "enabled",
        }),
        "fast-receive-0",
      ),
    ).toThrow("mismatched watch identity");
  });

  it("does not include key images in HTTP error messages", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () =>
        JSON.stringify({
          error: "server accidentally echoed " + "b".repeat(64),
        }),
    })) as ScannerFetch & jest.Mock;

    let message = "";
    try {
      await checkFastReceiveKeyImages(
        {
          scannerUrl: "https://xmr.tex8.com",
          identityId: "fast-receive-0",
          keyImages: ["b".repeat(64)],
        },
        fetchImpl,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("HTTP 500");
    expect(message).not.toContain("b".repeat(64));
  });
});
