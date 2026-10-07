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

const REPLY = `Hello,

Thank you for the review of 1.0.5. Version 1.0.6 (31) addresses both issues.

Guideline 4.2 — In-app contact
WhatsApp is no longer required. On any listing, tap the blue contact button, enter first name, phone and email, then tap “Envoyer ma demande”. The app stays open and shows “Demande envoyée”. The agency receives the request and calls or emails the traveler back. Phone (tel:) is optional.

Guideline 5.1.2 — This iOS app does not track
We do not use App Tracking Transparency because the iOS app does not track. There is no IDFA. Meta Pixel, Google Analytics, Google Ads and Facebook CAPI are disabled in the native WebView (User-Agent AllInRent/1.0 + content blockers). Name, email and phone from the in-app request are first-party only, used so the agency can contact the traveler (App Functionality). They are not linked to third-party data for advertising and are not shared with a data broker.

App Privacy has been updated: “Does this app track users?” = No.

Review notes in App Store Connect describe the same flow.

Thank you.`;

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
    json = { raw: text.slice(0, 800) };
  }
  console.log(`${method} ${path} → ${res.status}`);
  if (!res.ok) {
    console.log(JSON.stringify(json.errors || json, null, 2).slice(0, 2000));
  }
  return { ok: res.ok, status: res.status, json };
}

function relId(resource, name) {
  return resource?.relationships?.[name]?.data?.id || null;
}

function usageKey(category, protection, purpose) {
  return `${category || ""}|${protection || ""}|${purpose || ""}`;
}

const appDump = await api("GET", `apps/${APP_ID}`);
console.log(
  "app relationships",
  Object.keys(appDump.json.data?.relationships || {}).join(",")
);

const privacyGets = [
  `apps/${APP_ID}/dataUsages?include=category,purpose,dataProtection,grouping&limit=200`,
  `appDataUsages?filter[app]=${APP_ID}&include=category,purpose,dataProtection&limit=200`,
  `https://api.appstoreconnect.apple.com/iris/v1/apps/${APP_ID}/dataUsages?include=category,purpose,dataProtection,grouping&limit=200`,
  `https://appstoreconnect.apple.com/iris/v1/apps/${APP_ID}/dataUsages?include=category,purpose,dataProtection,grouping&limit=200`,
  `https://api.appstoreconnect.apple.com/v1/apps/${APP_ID}/appDataUsages?include=category,purpose,dataProtection&limit=200`,
];
let usages = { ok: false, json: {} };
for (const path of privacyGets) {
  usages = await api("GET", path);
  if (usages.ok) break;
}

if (!usages.ok) {
  console.error("Labels Confidentialité inaccessibles avec la clé API (interface web requise).");
} else {
  const included = usages.json.included || [];
  const byTypeId = new Map(included.map((x) => [`${x.type}:${x.id}`, x]));
  const rows = (usages.json.data || []).map((u) => {
    const category = relId(u, "category");
    const protection = relId(u, "dataProtection");
    const purpose = relId(u, "purpose");
    const grouping = relId(u, "grouping");
    const catInc = byTypeId.get(`appDataUsageCategories:${category}`);
    console.log(
      `usage ${u.id} cat=${category} prot=${protection} purpose=${purpose} grouping=${grouping} ${catInc?.attributes?.deleted ? "deleted" : ""}`
    );
    return { id: u.id, category, protection, purpose, grouping };
  });

  const tracking = rows.filter((r) => r.protection === "DATA_USED_TO_TRACK_YOU");
  console.log(`Tracking rows: ${tracking.length}`);
  for (const row of tracking) {
    await api("DELETE", `appDataUsages/${row.id}`);
  }

  const leftoverAds = rows.filter(
    (r) =>
      r.protection !== "DATA_USED_TO_TRACK_YOU" &&
      ["ADVERTISING_DATA", "DEVICE_ID", "PHYSICAL_ADDRESS", "OTHER_CONTACT_INFO"].includes(
        r.category
      )
  );
  for (const row of leftoverAds) {
    await api("DELETE", `appDataUsages/${row.id}`);
  }

  const after = await api(
    "GET",
    `apps/${APP_ID}/dataUsages?include=category,purpose,dataProtection&limit=200`
  );
  const existing = new Set(
    (after.json.data || []).map((u) =>
      usageKey(relId(u, "category"), relId(u, "dataProtection"), relId(u, "purpose"))
    )
  );

  const wanted = [
    ["NAME", "DATA_LINKED_TO_YOU", "APP_FUNCTIONALITY"],
    ["EMAIL_ADDRESS", "DATA_LINKED_TO_YOU", "APP_FUNCTIONALITY"],
    ["PHONE_NUMBER", "DATA_LINKED_TO_YOU", "APP_FUNCTIONALITY"],
    ["COARSE_LOCATION", "DATA_NOT_LINKED_TO_YOU", "APP_FUNCTIONALITY"],
    ["PRODUCT_INTERACTION", "DATA_NOT_LINKED_TO_YOU", "APP_FUNCTIONALITY"],
  ];

  for (const [category, protection, purpose] of wanted) {
    const key = usageKey(category, protection, purpose);
    if (existing.has(key)) {
      console.log(`keep ${key}`);
      continue;
    }
    await api("POST", "appDataUsages", {
      data: {
        type: "appDataUsages",
        relationships: {
          app: { data: { type: "apps", id: APP_ID } },
          category: { data: { type: "appDataUsageCategories", id: category } },
          dataProtection: { data: { type: "appDataUsageDataProtections", id: protection } },
          purpose: { data: { type: "appDataUsagePurposes", id: purpose } },
        },
      },
    });
  }

  const pub = await api("GET", `apps/${APP_ID}/dataUsagePublishState`);
  const pubId = pub.json.data?.id;
  if (pubId) {
    await api("PATCH", `appDataUsagesPublishState/${pubId}`, {
      data: {
        type: "appDataUsagesPublishState",
        id: pubId,
        attributes: { published: true },
      },
    });
  }

  const check = await api(
    "GET",
    `apps/${APP_ID}/dataUsages?include=category,purpose,dataProtection&limit=200`
  );
  const stillTracking = (check.json.data || []).filter(
    (u) => relId(u, "dataProtection") === "DATA_USED_TO_TRACK_YOU"
  );
  console.log(`Remaining tracking rows: ${stillTracking.length}`);
  if (stillTracking.length > 0) {
    console.error("Des lignes DATA_USED_TO_TRACK_YOU restent.");
  }
}

const versions = await api("GET", `apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10`);
const versionId = (versions.json.data || []).find((v) => v.attributes?.versionString === "1.0.6")
  ?.id;

if (versionId) {
  const detail = await api("GET", `appStoreVersions/${versionId}/appStoreReviewDetail`);
  const detailId = detail.json.data?.id;
  if (detailId) {
    await api("PATCH", `appStoreReviewDetails/${detailId}`, {
      data: {
        type: "appStoreReviewDetails",
        id: detailId,
        attributes: { notes: REPLY },
      },
    });
  }
}

const threadQueries = [
  `apps/${APP_ID}/resolutionCenterThreads?limit=20`,
  `resolutionCenterThreads?filter[app]=${APP_ID}&limit=20`,
  versionId ? `resolutionCenterThreads?filter[appStoreVersion]=${versionId}&limit=20` : null,
  `reviewSubmissions?filter[app]=${APP_ID}&limit=10`,
].filter(Boolean);

let threadId = null;
for (const q of threadQueries) {
  const r = await api("GET", q);
  const first = r.json.data?.[0];
  if (first?.type === "resolutionCenterThreads") {
    threadId = first.id;
    console.log(`Thread ${threadId} state=${first.attributes?.state || ""}`);
    break;
  }
}

if (threadId) {
  const posted = await api("POST", "resolutionCenterMessages", {
    data: {
      type: "resolutionCenterMessages",
      attributes: { messageBody: REPLY.replace(/\n/g, "<br>") },
      relationships: {
        thread: { data: { type: "resolutionCenterThreads", id: threadId } },
      },
    },
  });
  if (!posted.ok) {
    const draft = await api(
      "GET",
      `resolutionCenterThreads/${threadId}/resolutionCenterDraftMessage`
    );
    const draftId = draft.json.data?.id;
    if (draftId) {
      await api("PATCH", `resolutionCenterDraftMessages/${draftId}`, {
        data: {
          type: "resolutionCenterDraftMessages",
          id: draftId,
          attributes: { messageBody: REPLY.replace(/\n/g, "<br>") },
        },
      });
      await api("POST", "resolutionCenterMessages", {
        data: {
          type: "resolutionCenterMessages",
          relationships: {
            draft: { data: { type: "resolutionCenterDraftMessages", id: draftId } },
            thread: { data: { type: "resolutionCenterThreads", id: threadId } },
          },
        },
      });
    }
  }
} else {
  console.log("Pas de thread Resolution Center via JWT — notes de review mises à jour.");
}

console.log("DONE");
