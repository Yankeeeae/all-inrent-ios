import { createHash, createSign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = "6813145770";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMO_DIR = path.join(__dirname, "promo");
const PROMO_NAMES = ["01_decouverte.png", "02_recherche.png", "03_fiche.png"];
const KEY_ID = process.env.APP_STORE_CONNECT_KEY_ID;
const ISSUER = process.env.APP_STORE_CONNECT_ISSUER_ID;
const KEY_PATH = process.env.APP_STORE_CONNECT_API_KEY_PATH;

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

async function api(method, apiPath, body, rawBody, headers) {
  const url = apiPath.startsWith("http") ? apiPath : `https://api.appstoreconnect.apple.com/v1/${apiPath}`;
  const requestHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(headers || {}),
  };
  if (body) requestHeaders["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : rawBody,
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
  }
  const label = apiPath.startsWith("http") ? "upload" : `${method} ${apiPath.split("?")[0]}`;
  console.log(`${label} → ${res.status}`);
  if (!res.ok && json) console.log(JSON.stringify(json.errors || json, null, 2).slice(0, 1800));
  return { ok: res.ok, status: res.status, json };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function md5(buffer) {
  return createHash("md5").update(buffer).digest("hex");
}

function promoFor(width, height) {
  const dir = path.join(PROMO_DIR, `${width}x${height}`);
  try {
    const names = new Set(readdirSync(dir));
    if (!PROMO_NAMES.every((name) => names.has(name))) return null;
    return PROMO_NAMES.map((name) => readFileSync(path.join(dir, name)));
  } catch {
    return null;
  }
}

async function uploadScreenshot(setId, fileName, fileBuffer) {
  const created = await api("POST", "appScreenshots", {
    data: {
      type: "appScreenshots",
      attributes: { fileName, fileSize: fileBuffer.length },
      relationships: {
        appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } },
      },
    },
  });
  if (!created.ok) throw new Error(`Création de ${fileName} refusée`);
  const id = created.json.data.id;
  for (const op of created.json.data.attributes.uploadOperations || []) {
    const chunk = fileBuffer.subarray(op.offset, op.offset + op.length);
    const headers = {};
    for (const header of op.requestHeaders || []) headers[header.name] = header.value;
    const sent = await fetch(op.url, { method: op.method || "PUT", headers, body: chunk });
    if (!sent.ok) throw new Error(`Envoi de ${fileName} refusé (${sent.status})`);
  }
  const committed = await api("PATCH", `appScreenshots/${id}`, {
    data: {
      type: "appScreenshots",
      id,
      attributes: { uploaded: true, sourceFileChecksum: md5(fileBuffer) },
    },
  });
  if (!committed.ok) throw new Error(`Validation de ${fileName} refusée`);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const check = await api("GET", `appScreenshots/${id}`);
    const state = check.json?.data?.attributes?.assetDeliveryState?.state;
    const errors = check.json?.data?.attributes?.assetDeliveryState?.errors || [];
    console.log(`${fileName} ${state || "en cours"}`);
    if (state === "COMPLETE") return id;
    if (state === "FAILED") throw new Error(`${fileName} rejeté : ${JSON.stringify(errors).slice(0, 400)}`);
    await sleep(3000);
  }
  throw new Error(`${fileName} n'a pas été accepté à temps`);
}

async function screenshotsOf(setId) {
  const listed = await api("GET", `appScreenshotSets/${setId}/appScreenshots?limit=10`);
  if (!listed.ok) return [];
  return listed.json.data || [];
}

async function replaceSet(set) {
  const display = set.attributes?.screenshotDisplayType;
  const current = await screenshotsOf(set.id);
  if (!current.length) {
    console.log(`Ensemble ${display} vide, laissé tel quel`);
    return false;
  }
  const size = current[0].attributes?.imageAsset;
  const promos = size ? promoFor(size.width, size.height) : null;
  if (!promos) {
    console.log(`Ensemble ${display} en ${size?.width}x${size?.height} : taille non préparée, laissé tel quel`);
    return false;
  }
  for (const shot of current) {
    const removed = await api("DELETE", `appScreenshots/${shot.id}`);
    if (!removed.ok) throw new Error(`Suppression refusée pour ${display}`);
  }
  let index = 1;
  for (const file of promos) {
    await uploadScreenshot(set.id, `${String(index).padStart(2, "0")}_promo.png`, file);
    index += 1;
  }
  console.log(`${display} : ${promos.length} visuels en place`);
  return true;
}

async function unlock(versionId) {
  const reviews = await api("GET", `apps/${APP_ID}/reviewSubmissions?filter[platform]=IOS&limit=20`);
  if (!reviews.ok) return;
  for (const review of reviews.json.data || []) {
    const state = review.attributes?.state;
    if (state === "COMPLETE" || state === "CANCELED" || review.attributes?.canceled) continue;
    const items = await api("GET", `reviewSubmissions/${review.id}/items?limit=20`);
    const linked = (items.json?.data || []).some((item) => {
      return item.relationships?.appStoreVersion?.data?.id === versionId;
    });
    if (!linked) continue;
    console.log(`Retrait de la review ${review.id} (${state}) pour mettre à jour les captures`);
    await api("PATCH", `reviewSubmissions/${review.id}`, {
      data: { type: "reviewSubmissions", id: review.id, attributes: { canceled: true } },
    });
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

async function submit(versionId) {
  const created = await api("POST", "reviewSubmissions", {
    data: {
      type: "reviewSubmissions",
      attributes: { platform: "IOS" },
      relationships: { app: { data: { type: "apps", id: APP_ID } } },
    },
  });
  if (!created.ok) return false;
  const reviewId = created.json.data.id;
  const item = await api("POST", "reviewSubmissionItems", {
    data: {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: { data: { type: "reviewSubmissions", id: reviewId } },
        appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
      },
    },
  });
  if (!item.ok) return false;
  const submitted = await api("PATCH", `reviewSubmissions/${reviewId}`, {
    data: { type: "reviewSubmissions", id: reviewId, attributes: { submitted: true } },
  });
  if (!submitted.ok) return false;
  console.log(`Soumis à Apple : review ${reviewId}`);
  return true;
}

const versions = await api("GET", `apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10`);
if (!versions.ok) process.exit(1);
for (const version of versions.json.data || []) {
  console.log(`Version ${version.attributes?.versionString} ${version.attributes?.appStoreState}`);
}

const editableStates = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
]);
async function createNextVersion(live) {
  const parts = String(live.attributes?.versionString || "1.0.12").split(".");
  const next = parts.map((part, index) => (index === parts.length - 1 ? String(Number(part) + 1) : part)).join(".");
  console.log(`Création de la version ${next} à partir de ${live.attributes.versionString}`);
  const created = await api("POST", "appStoreVersions", {
    data: {
      type: "appStoreVersions",
      attributes: { platform: "IOS", versionString: next },
      relationships: { app: { data: { type: "apps", id: APP_ID } } },
    },
  });
  if (!created.ok) return null;
  const version = created.json.data;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(3000);
    const locales = await api("GET", `appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=20`);
    const first = locales.json?.data?.[0];
    const description = first?.attributes?.description || "";
    const sets = first
      ? await api("GET", `appStoreVersionLocalizations/${first.id}/appScreenshotSets?limit=20`)
      : { json: { data: [] } };
    const shots = [];
    for (const set of sets.json?.data || []) {
      if (!String(set.attributes?.screenshotDisplayType || "").startsWith("APP_IPHONE_")) continue;
      shots.push(...(await screenshotsOf(set.id)));
    }
    console.log(`Reprise fiche : texte ${description.length} caractères, ${shots.length} capture(s) iPhone`);
    if (description && shots.length) return version;
  }
  console.error("La nouvelle version n'a pas repris la fiche. Elle est retirée.");
  await api("DELETE", `appStoreVersions/${version.id}`);
  return null;
}

const candidates = (versions.json.data || []).filter((version) => editableStates.has(version.attributes?.appStoreState));
const preferred = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY", "WAITING_FOR_REVIEW", "IN_REVIEW"];
candidates.sort((a, b) => preferred.indexOf(a.attributes.appStoreState) - preferred.indexOf(b.attributes.appStoreState));
let target = candidates[0];
let createdVersion = false;
if (!target) {
  const live = (versions.json.data || []).find((version) => version.attributes?.appStoreState === "READY_FOR_SALE");
  if (!live) {
    console.error("Aucune version modifiable.");
    process.exit(2);
  }
  target = await createNextVersion(live);
  createdVersion = true;
  if (!target) process.exit(2);
}

console.log(`Version retenue ${target.attributes.versionString} ${target.attributes.appStoreState}`);
if (target.attributes.appStoreState === "WAITING_FOR_REVIEW" || target.attributes.appStoreState === "IN_REVIEW") {
  await unlock(target.id);
}

const localizations = await api("GET", `appStoreVersions/${target.id}/appStoreVersionLocalizations?limit=20`);
if (!localizations.ok) process.exit(1);

let replaced = 0;
for (const locale of localizations.json.data || []) {
  console.log(`Langue ${locale.attributes?.locale}`);
  const sets = await api("GET", `appStoreVersionLocalizations/${locale.id}/appScreenshotSets?limit=20`);
  if (!sets.ok) process.exit(1);
  for (const set of sets.json.data || []) {
    if (!String(set.attributes?.screenshotDisplayType || "").startsWith("APP_IPHONE_")) continue;
    if (await replaceSet(set)) replaced += 1;
  }
}

if (!replaced) {
  console.error("Aucun ensemble iPhone mis à jour");
  process.exit(1);
}

const fresh = await api("GET", `appStoreVersions/${target.id}`);
const state = fresh.json?.data?.attributes?.appStoreState;
if (createdVersion) {
  console.log(`Captures en place sur ${target.attributes?.versionString || "la nouvelle version"}. Le build doit être joint avant la review.`);
  process.exit(0);
}
if (state === "WAITING_FOR_REVIEW" || state === "IN_REVIEW") {
  console.log(`Les captures sont en place. La version est déjà chez Apple (${state}).`);
  process.exit(0);
}

const ok = await submit(target.id);
if (!ok) {
  console.error("Les captures sont enregistrées, mais la soumission à Apple a été refusée.");
  process.exit(1);
}
