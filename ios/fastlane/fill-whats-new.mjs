import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const APP_ID = "6813145770";
const VERSION = process.env.APP_STORE_VERSION || "1.0.13";
const KEY_ID = process.env.APP_STORE_CONNECT_KEY_ID;
const ISSUER = process.env.APP_STORE_CONNECT_ISSUER_ID;
const KEY_PATH = process.env.APP_STORE_CONNECT_API_KEY_PATH;
const NOTES = {
  "fr-FR": "Nouvelle présentation des visuels sur l’App Store.",
  "en-US": "Updated App Store preview images.",
};

if (!KEY_ID || !ISSUER || !KEY_PATH) {
  console.error("Missing APP_STORE_CONNECT_* env");
  process.exit(1);
}

function jwtToken() {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iss: ISSUER, iat: now, exp: now + 19 * 60, aud: "appstoreconnect-v1" })
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

async function api(method, apiPath, body) {
  const url = apiPath.startsWith("http") ? apiPath : `https://api.appstoreconnect.apple.com/v1/${apiPath}`;
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
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  console.log(`${method} ${apiPath.split("?")[0]} → ${res.status}`);
  if (!res.ok) console.log(JSON.stringify(json?.errors || json, null, 2).slice(0, 1500));
  return { ok: res.ok, json };
}

const versions = await api(
  "GET",
  `apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${VERSION}&limit=5`
);
const version = versions.json?.data?.[0];
if (!versions.ok || !version) process.exit(1);
console.log(`Version ${version.attributes.versionString} ${version.attributes.appStoreState}`);

const locales = await api("GET", `appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=20`);
if (!locales.ok) process.exit(1);
for (const row of locales.json.data || []) {
  const locale = row.attributes?.locale;
  const note = NOTES[locale];
  if (!note || row.attributes?.whatsNew) {
    console.log(`${locale} déjà renseigné`);
    continue;
  }
  const patched = await api("PATCH", `appStoreVersionLocalizations/${row.id}`, {
    data: {
      type: "appStoreVersionLocalizations",
      id: row.id,
      attributes: { whatsNew: note },
    },
  });
  if (!patched.ok) process.exit(1);
  console.log(`${locale} nouveautés ajoutées`);
}
