import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const BUNDLE_ID = process.env.APP_BUNDLE_ID || "com.allinrent.pro";
const APP_NAME = process.env.APP_NAME || "ALL IN RENT PRO";
const SKU = process.env.APP_SKU || "allinrent-pro";
const KEY_ID = process.env.APP_STORE_CONNECT_KEY_ID;
const ISSUER = process.env.APP_STORE_CONNECT_ISSUER_ID;
const KEY_PATH = process.env.APP_STORE_CONNECT_API_KEY_PATH;

function jwtToken() {
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" })
  ).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      iat: now,
      exp: now + 19 * 60,
      aud: "appstoreconnect-v1",
    })
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const pem = readFileSync(KEY_PATH, "utf8");
  const signer = createSign("SHA256");
  signer.update(unsigned);
  signer.end();
  const sig = signer
    .sign({ key: pem, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${unsigned}.${sig}`;
}

const token = jwtToken();

async function api(method, path, body) {
  const url = path.startsWith("http")
    ? path
    : `https://api.appstoreconnect.apple.com/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  console.log(`${method} ${path} → ${res.status}`);
  if (!res.ok) {
    console.log(JSON.stringify(json.errors || json, null, 2).slice(0, 2500));
  }
  return { ok: res.ok, status: res.status, json };
}

function alreadyExists(json) {
  const errors = json?.errors || [];
  return errors.some((error) => {
    const code = String(error.code || "");
    const detail = String(error.detail || error.title || "").toLowerCase();
    return (
      code.includes("ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE") ||
      code.includes("ENTITY_ERROR.RELATIONSHIP") ||
      detail.includes("already") ||
      detail.includes("exists") ||
      detail.includes("duplicate")
    );
  });
}

const bundleList = await api(
  "GET",
  `bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}&limit=10`
);
let bundleRow = (bundleList.json?.data || []).find(
  (row) => row.attributes?.identifier === BUNDLE_ID
);

if (!bundleRow) {
  const createdBundle = await api("POST", "bundleIds", {
    data: {
      type: "bundleIds",
      attributes: {
        identifier: BUNDLE_ID,
        name: "ALLINRENTPRO",
        platform: "IOS",
      },
    },
  });
  bundleRow = createdBundle.json?.data;
  if (!createdBundle.ok || !bundleRow?.id) {
    const retry = await api(
      "GET",
      `bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}&limit=10`
    );
    bundleRow = (retry.json?.data || []).find(
      (row) => row.attributes?.identifier === BUNDLE_ID
    );
  }
}

if (!bundleRow?.id) {
  console.error("Unable to create or find Developer App ID");
  process.exit(1);
}

console.log(`Bundle ID ${BUNDLE_ID} id=${bundleRow.id}`);

for (const capabilityType of ["PUSH_NOTIFICATIONS", "ASSOCIATED_DOMAINS"]) {
  const cap = await api("POST", "bundleIdCapabilities", {
    data: {
      type: "bundleIdCapabilities",
      attributes: { capabilityType },
      relationships: {
        bundleId: {
          data: { type: "bundleIds", id: bundleRow.id },
        },
      },
    },
  });
  if (!cap.ok && !alreadyExists(cap.json) && cap.status !== 409) {
    console.log(`Capability ${capabilityType} skipped`);
  }
}

const existingApp = await api(
  "GET",
  `apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=5`
);
if (existingApp.json?.data?.[0]?.id) {
  console.log(`App Store app already exists id=${existingApp.json.data[0].id}`);
} else {
  const createdApp = await api("POST", "apps", {
    data: {
      type: "apps",
      attributes: {
        bundleId: BUNDLE_ID,
        name: APP_NAME,
        primaryLocale: "fr-FR",
        sku: SKU,
      },
    },
  });
  if (!createdApp.ok && !alreadyExists(createdApp.json)) {
    console.error("Unable to create App Store Connect app");
    process.exit(1);
  }
}

const check = await api(
  "GET",
  `apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=5`
);
if (!check.json?.data?.[0]?.id) {
  console.error("App still missing after bootstrap");
  process.exit(1);
}

console.log("ALL IN RENT PRO App Store listing is ready");
