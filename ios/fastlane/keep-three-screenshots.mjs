import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const APP_ID = "6813145770";
const VERSION = process.env.APP_STORE_VERSION || "1.0.13";
const KEY_ID = process.env.APP_STORE_CONNECT_KEY_ID;
const ISSUER = process.env.APP_STORE_CONNECT_ISSUER_ID;
const KEY_PATH = process.env.APP_STORE_CONNECT_API_KEY_PATH;
const PROMO = /^0[123]_promo\.png$/i;

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
      ...(body ? { "Content-Type": "application/json" } : {}),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function versionIdOfItem(item) {
  const direct = item.relationships?.appStoreVersion?.data?.id;
  if (direct) return direct;
  const detail = await api("GET", `reviewSubmissionItems/${item.id}?include=appStoreVersion`);
  return (
    detail.json?.data?.relationships?.appStoreVersion?.data?.id ||
    (detail.json?.included || []).find((row) => row.type === "appStoreVersions")?.id ||
    null
  );
}

async function cancelReview(review) {
  console.log(`Retrait de la review ${review.id} (${review.attributes?.state})`);
  const canceled = await api("PATCH", `reviewSubmissions/${review.id}`, {
    data: { type: "reviewSubmissions", id: review.id, attributes: { canceled: true } },
  });
  return canceled.ok;
}

async function unlock(versionId) {
  const legacy = await api("GET", `appStoreVersions/${versionId}/appStoreVersionSubmission`);
  if (legacy.ok && legacy.json?.data?.id) {
    console.log(`Retrait de la soumission ${legacy.json.data.id}`);
    await api("DELETE", `appStoreVersionSubmissions/${legacy.json.data.id}`);
  }
  const reviews = await api("GET", `apps/${APP_ID}/reviewSubmissions?filter[platform]=IOS&limit=20`);
  if (!reviews.ok) return null;
  const open = (reviews.json.data || []).filter((review) => {
    const state = review.attributes?.state;
    return state !== "COMPLETE" && state !== "CANCELED" && !review.attributes?.canceled;
  });
  const targets = [];
  for (const review of open) {
    const items = await api("GET", `reviewSubmissions/${review.id}/items?limit=20&include=appStoreVersion`);
    const rows = items.json?.data || [];
    console.log(`review ${review.id} ${review.attributes?.state} items=${rows.length}`);
    const ids = [];
    for (const item of rows) {
      const id = await versionIdOfItem(item);
      ids.push(id);
      console.log(`  item ${item.id} version ${id || JSON.stringify(item.relationships || {}).slice(0, 240)}`);
    }
    if (ids.includes(versionId) || (open.length === 1 && ids.every((id) => !id))) targets.push(review);
  }
  for (const review of targets) {
    const canceled = await cancelReview(review);
    if (!canceled) return null;
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const version = await api("GET", `appStoreVersions/${versionId}`);
    const state = version.json?.data?.attributes?.appStoreState;
    console.log(`Version ${state}`);
    if (state === "PREPARE_FOR_SUBMISSION" || state === "DEVELOPER_REJECTED" || state === "REJECTED") return state;
    await sleep(5000);
  }
  return null;
}

const versions = await api(
  "GET",
  `apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${VERSION}&limit=5`
);
const version = versions.json?.data?.[0];
if (!versions.ok || !version) process.exit(1);
console.log(`Version ${version.attributes.versionString} ${version.attributes.appStoreState}`);

const locked = version.attributes.appStoreState === "WAITING_FOR_REVIEW" || version.attributes.appStoreState === "IN_REVIEW";
if (locked) {
  const state = await unlock(version.id);
  if (!state) {
    console.error("La version est encore chez Apple. Les captures ne peuvent pas être modifiées.");
    process.exit(1);
  }
}

const localizations = await api("GET", `appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=20`);
if (!localizations.ok) process.exit(1);

let setsTouched = 0;
for (const locale of localizations.json.data || []) {
  const language = locale.attributes?.locale;
  console.log(`Langue ${language}`);
  const sets = await api("GET", `appStoreVersionLocalizations/${locale.id}/appScreenshotSets?limit=20`);
  if (!sets.ok) process.exit(1);
  for (const set of sets.json.data || []) {
    const display = set.attributes?.screenshotDisplayType || "";
    if (!display.startsWith("APP_IPHONE_")) continue;
    const listed = await api("GET", `appScreenshotSets/${set.id}/appScreenshots?limit=10`);
    if (!listed.ok) process.exit(1);
    const shots = listed.json.data || [];
    const promos = shots.filter((shot) => PROMO.test(shot.attributes?.fileName || ""));
    const extras = shots.filter((shot) => !PROMO.test(shot.attributes?.fileName || ""));
    for (const shot of shots) console.log(`  ${shot.attributes?.fileName || shot.id}`);
    if (promos.length !== 3) {
      console.error(`${language} ${display} : ${promos.length} visuel(s) promo, suppression annulée`);
      process.exit(1);
    }
    for (const shot of extras) {
      const removed = await api("DELETE", `appScreenshots/${shot.id}`);
      if (!removed.ok) process.exit(1);
      console.log(`  retiré ${shot.attributes?.fileName || shot.id}`);
    }
    const after = await api("GET", `appScreenshotSets/${set.id}/appScreenshots?limit=10`);
    const left = after.json?.data || [];
    console.log(`${language} ${display} : ${left.length} capture(s)`);
    if (left.length !== 3) process.exit(1);
    setsTouched += 1;
  }
}

if (!setsTouched) {
  console.error("Aucun ensemble iPhone traité");
  process.exit(1);
}
console.log(`Fiche ${VERSION} limitée aux 3 visuels.`);
