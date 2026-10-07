import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const APP_ID = "6813145770";
const VERSION = process.env.APP_STORE_VERSION || "1.0.6";
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

const versions = await api(
  "GET",
  `apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10`
);
if (!versions.ok) process.exit(1);

for (const v of versions.json.data || []) {
  console.log(
    `Version ${v.attributes?.versionString} state=${v.attributes?.appStoreState} id=${v.id}`
  );
}

const target =
  (versions.json.data || []).find((v) => v.attributes?.versionString === VERSION) ||
  (versions.json.data || [])[0];
if (!target) {
  console.error(`Version ${VERSION} introuvable`);
  process.exit(1);
}

const existingSubmission = await api(
  "GET",
  `appStoreVersions/${target.id}/appStoreVersionSubmission`
);
if (existingSubmission.ok && existingSubmission.json.data?.id) {
  const subId = existingSubmission.json.data.id;
  console.log(`Version déjà soumise id=${subId} — on la retire pour resoumettre`);
  await api("DELETE", `appStoreVersionSubmissions/${subId}`);
}

const reviews = await api(
  "GET",
  `apps/${APP_ID}/reviewSubmissions?filter[platform]=IOS&limit=20`
);
if (reviews.ok) {
  for (const item of reviews.json.data || []) {
    const state = item.attributes?.state;
    const canceled = item.attributes?.canceled;
    console.log(`ReviewSubmission ${item.id} state=${state} canceled=${canceled}`);
    if (canceled) continue;
    if (
      state === "READY_FOR_REVIEW" ||
      state === "WAITING_FOR_REVIEW" ||
      state === "UNRESOLVED_ISSUES" ||
      state === "IN_REVIEW"
    ) {
      const cancel = await api("PATCH", `reviewSubmissions/${item.id}`, {
        data: {
          type: "reviewSubmissions",
          id: item.id,
          attributes: { canceled: true },
        },
      });
      if (!cancel.ok && state !== "IN_REVIEW") {
        console.log("Annulation reviewSubmission ignorée, on continue");
      }
    }
  }
}

for (const v of versions.json.data || []) {
  const state = v.attributes?.appStoreState;
  if (v.id === target.id) continue;
  if (state === "WAITING_FOR_REVIEW" || state === "PREPARE_FOR_SUBMISSION") {
    const sub = await api("GET", `appStoreVersions/${v.id}/appStoreVersionSubmission`);
    if (sub.ok && sub.json.data?.id) {
      await api("DELETE", `appStoreVersionSubmissions/${sub.json.data.id}`);
    }
  }
}

const created = await api("POST", "reviewSubmissions", {
  data: {
    type: "reviewSubmissions",
    attributes: { platform: "IOS" },
    relationships: {
      app: { data: { type: "apps", id: APP_ID } },
    },
  },
});
if (!created.ok) process.exit(1);

const reviewId = created.json.data?.id;
const item = await api("POST", "reviewSubmissionItems", {
  data: {
    type: "reviewSubmissionItems",
    relationships: {
      reviewSubmission: { data: { type: "reviewSubmissions", id: reviewId } },
      appStoreVersion: { data: { type: "appStoreVersions", id: target.id } },
    },
  },
});
if (!item.ok) process.exit(1);

const submitted = await api("PATCH", `reviewSubmissions/${reviewId}`, {
  data: {
    type: "reviewSubmissions",
    id: reviewId,
    attributes: { submitted: true },
  },
});
if (!submitted.ok) process.exit(1);

console.log(`OK reviewSubmission ${reviewId} pour ${VERSION} (${target.id})`);
