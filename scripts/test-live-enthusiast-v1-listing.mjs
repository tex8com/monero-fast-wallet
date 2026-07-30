#!/usr/bin/env node

const origin = (process.env.ENTHUSIAST_V1_ORIGIN ?? "https://xmr.tex8.com")
  .replace(/\/+$/, "");
let accessToken = "";

async function request(route, options = {}) {
  const response = await fetch(`${origin}/${route.replace(/^\/+/, "")}`, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`${route} returned HTTP ${response.status}: ${detail}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

try {
  const identity = await request("v2/identities", { method: "POST" });
  if (!/^person_[0-9a-f]{32}$/.test(identity.identityId) ||
      !/^[0-9a-f]{64}$/.test(identity.accessToken)) {
    throw new Error("The live server returned an invalid identity");
  }
  accessToken = identity.accessToken;

  const marker = `live-test-${Date.now()}`;
  const created = await request("v2/content", {
    method: "POST",
    body: JSON.stringify({
      kind: "product_listing",
      title: `Community product ${marker}`,
      summary:
        "Temporary end-to-end product listing used to verify authenticated server storage.",
      roles: [],
      categories: ["test", "privacy"],
      languages: ["en"],
      coarseRegion: null,
      radiusKm: null,
      media: [],
    }),
  });
  if (created.draft?.kind !== "product_listing" ||
      created.status !== "awaiting_screening") {
    throw new Error("The product listing did not enter the review queue");
  }

  const records = await request("v2/content");
  const stored = records.find(
    (record) =>
      record.publicId === created.publicId &&
      record.draft?.title === `Community product ${marker}`,
  );
  if (!stored) {
    throw new Error("The authenticated listing read did not return the stored product");
  }

  console.log(
    JSON.stringify({
      ok: true,
      identityCreated: true,
      productStored: true,
      productKind: stored.draft.kind,
      reviewStatus: stored.status,
    }),
  );
} finally {
  if (accessToken) {
    await request("v2/identity/delete", {
      method: "POST",
      body: JSON.stringify({
        confirmation: "DELETE MY COMMUNITY PROFILE",
      }),
    });
  }
}
