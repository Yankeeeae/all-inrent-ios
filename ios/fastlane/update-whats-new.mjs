import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = "6813145770";
const VERSION = process.env.APP_STORE_VERSION || "1.0.12";
const KEY_ID = process.env.APP_STORE_CONNECT_KEY_ID;
const ISSUER = process.env.APP_STORE_CONNECT_ISSUER_ID;
const KEY_PATH = process.env.APP_STORE_CONNECT_API_KEY_PATH;
const here = dirname(fileURLToPath(import.meta.url));

const COPY = {
  fr: {
    locale: "fr-FR",
    whatsNew: readFileSync(join(here, "metadata/fr-FR/release_notes.txt"), "utf8").replace(/^\uFEFF/, "").trim(),
    description: readFileSync(join(here, "metadata/fr-FR/description.txt"), "utf8").replace(/^\uFEFF/, "").trim(),
    promotionalText: readFileSync(join(here, "metadata/fr-FR/promotional_text.txt"), "utf8")
      .replace(/^\uFEFF/, "")
      .trim(),
  },
  en: {
    locale: "en-US",
    whatsNew: readFileSync(join(here, "metadata/en-US/release_notes.txt"), "utf8").replace(/^\uFEFF/, "").trim(),
    description: readFileSync(join(here, "metadata/en-US/description.txt"), "utf8").replace(/^\uFEFF/, "").trim(),
    promotionalText: readFileSync(join(here, "metadata/en-US/promotional_text.txt"), "utf8")
      .replace(/^\uFEFF/, "")
      .trim(),
  },
};

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

const versions = await api(
  "GET",
  `apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${VERSION}&limit=5`
);
if (!versions.ok || !versions.json.data?.length) {
  console.error("Version App Store introuvable");
  process.exit(1);
}

const version = versions.json.data[0];
const state = version.attributes?.appStoreState;
console.log(`Version ${version.attributes?.versionString} state=${state} id=${version.id}`);
if (
  state === "PENDING_DEVELOPER_RELEASE" ||
  state === "READY_FOR_SALE" ||
  state === "PROCESSING_FOR_APP_STORE"
) {
  console.log("Copy figée dans cet état — skip What's New / description");
  process.exit(0);
}

const locs = await api("GET", `appStoreVersions/${version.id}/appStoreVersionLocalizations`);
if (!locs.ok) process.exit(1);

const byLocale = Object.fromEntries(
  (locs.json.data || []).map((row) => [row.attributes?.locale, row])
);

for (const item of Object.values(COPY)) {
  const row = byLocale[item.locale];
  if (!row) {
    console.error(`Localization ${item.locale} introuvable`);
    process.exit(1);
  }
  const patched = await api("PATCH", `appStoreVersionLocalizations/${row.id}`, {
    data: {
      type: "appStoreVersionLocalizations",
      id: row.id,
      attributes: {
        whatsNew: item.whatsNew.slice(0, 4000),
        description: item.description.slice(0, 4000),
        promotionalText: item.promotionalText.slice(0, 170),
      },
    },
  });
  if (!patched.ok) process.exit(1);
  console.log(`OK ${item.locale} whatsNew=${item.whatsNew.length} desc=${item.description.length}`);
}
