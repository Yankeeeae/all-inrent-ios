import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const APP_ID = "6813145770";
const KEY_ID = process.env.APP_STORE_CONNECT_KEY_ID;
const ISSUER = process.env.APP_STORE_CONNECT_ISSUER_ID;
const KEY_PATH = process.env.APP_STORE_CONNECT_API_KEY_PATH;

if (!KEY_ID || !ISSUER || !KEY_PATH) {
  console.error("Missing APP_STORE_CONNECT_* env");
  process.exit(1);
}

function jwtToken() {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" })).toString(
    "base64url"
  );
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
  const sig = signer.sign({ key: pem, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${unsigned}.${sig}`;
}

const token = jwtToken();

async function api(method, path, body) {
  const url = path.startsWith("http") ? path : `https://api.appstoreconnect.apple.com/v1/${path}`;
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
    json = { raw: text.slice(0, 800) };
  }
  console.log(`${method} ${path} → ${res.status}`);
  if (!res.ok) {
    console.log(JSON.stringify(json.errors || json, null, 2).slice(0, 2500));
  }
  return { ok: res.ok, status: res.status, json };
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

const versions = await api(
  "GET",
  `apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10`
);
if (!versions.ok) process.exit(1);

const pending = (versions.json.data || []).filter(
  (v) => v.attributes?.appStoreState === "PENDING_DEVELOPER_RELEASE"
);

if (pending.length === 0) {
  for (const v of versions.json.data || []) {
    console.log(`Version ${v.attributes?.versionString} state=${v.attributes?.appStoreState}`);
  }
  console.log("Aucune version PENDING_DEVELOPER_RELEASE");
  process.exit(0);
}

for (const v of pending) {
  const versionString = v.attributes?.versionString;
  console.log(`Release ${versionString} id=${v.id}`);
  const released = await api("POST", "appStoreVersionReleaseRequests", {
    data: {
      type: "appStoreVersionReleaseRequests",
      relationships: {
        appStoreVersion: {
          data: { type: "appStoreVersions", id: v.id },
        },
      },
    },
  });
  if (!released.ok && released.status !== 409) {
    process.exit(1);
  }
}

for (let i = 0; i < 12; i++) {
  await sleep(5000);
  const again = await api(
    "GET",
    `apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10`
  );
  if (!again.ok) process.exit(1);
  const stillPending = (again.json.data || []).filter(
    (v) => v.attributes?.appStoreState === "PENDING_DEVELOPER_RELEASE"
  );
  for (const v of again.json.data || []) {
    console.log(`Version ${v.attributes?.versionString} state=${v.attributes?.appStoreState}`);
  }
  if (stillPending.length === 0) {
    console.log("OK versions approuvées publiées");
    process.exit(0);
  }
}

console.error("Timeout: version encore PENDING_DEVELOPER_RELEASE");
process.exit(1);
