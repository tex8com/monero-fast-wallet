import {
  checkFastReceiveKeyImages,
  parseKeyImageStatusResponse,
  type ScannerFetch,
} from "../FastReceiveScannerClient";

describe("FastReceiveScannerClient", () => {
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
        scannerUrl: "https://scanner.tex8.com/",
        scannerAuthToken: "secret-token",
        identityId: "fast-receive-0",
        keyImages: ["A".repeat(64)],
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://scanner.tex8.com/v1/fast-receive/key-images/status",
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
          scannerUrl: "https://scanner.tex8.com",
          identityId: "fast-receive-0",
          keyImages: ["not-a-key-image"],
        },
        fetchImpl,
      ),
    ).rejects.toThrow("64-character hex");

    expect(fetchImpl).not.toHaveBeenCalled();
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
          scannerUrl: "https://scanner.tex8.com",
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
