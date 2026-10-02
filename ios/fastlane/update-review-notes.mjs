import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = "6813145770";
const VERSION = "1.0.4";
const KEY_ID = process.env.APP_STORE_CONNECT_KEY_ID;
const ISSUER = process.env.APP_STORE_CONNECT_ISSUER_ID;
const KEY_PATH = process.env.APP_STORE_CONNECT_API_KEY_PATH;
const here = dirname(fileURLToPath(import.meta.url));
const notes = readFileSync(join(here, "metadata/review_information/notes.txt"), "utf8")
  .replace(/^\uFEFF/, "")
  .trim();

if (!KEY_ID || !ISSUER || !KEY_PATH) {
  console.error("Missing APP_STORE_CONNECT_* env");
  process.exit(1);
}
if (notes.length > 4000) {
  console.error(`Notes trop longues: ${notes.length}`);
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

const versions = await api(
  "GET",
  `apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${VERSION}&limit=5`
);
if (!versions.ok || !versions.json.data?.length) {
  console.error("Version App Store introuvable");
  process.exit(1);
}

const version = versions.json.data[0];
console.log(`Version ${version.attributes?.versionString} state=${version.attributes?.appStoreState} id=${version.id}`);

const existing = await api("GET", `appStoreVersions/${version.id}/appStoreReviewDetail`);
const attributes = {
  contactFirstName: "ALL",
  contactLastName: "IN RENT",
  contactPhone: "+33767501697",
  contactEmail: "allinrent.off@gmail.com",
  demoAccountName: "",
  demoAccountPassword: "",
  demoAccountRequired: false,
  notes,
};

if (existing.ok && existing.json.data?.id) {
  const patched = await api("PATCH", `appStoreReviewDetails/${existing.json.data.id}`, {
    data: {
      type: "appStoreReviewDetails",
      id: existing.json.data.id,
      attributes,
    },
  });
  if (!patched.ok) process.exit(1);
} else {
  const created = await api("POST", "appStoreReviewDetails", {
    data: {
      type: "appStoreReviewDetails",
      attributes,
      relationships: {
        appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
      },
    },
  });
  if (!created.ok) process.exit(1);
}

console.log(`OK notes App Review (${notes.length} chars), demoAccountRequired=false`);
