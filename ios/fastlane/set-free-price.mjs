import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const APP_ID = "6813145770";
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

function isFree(point) {
  const price = String(point?.attributes?.customerPrice ?? "")
    .replace(",", ".")
    .trim();
  return price === "0" || price === "0.0" || price === "0.00";
}

async function allTerritories() {
  const ids = [];
  let path = "territories?limit=200";
  for (let i = 0; i < 10; i += 1) {
    const { ok, json } = await api("GET", path);
    if (!ok) break;
    ids.push(...(json.data || []).map((row) => row.id));
    const next = json.links?.next;
    if (!next) break;
    path = next.replace("https://api.appstoreconnect.apple.com/v1/", "");
  }
  return [...new Set(ids)];
}

async function freePricePoint() {
  const tries = [
    `apps/${APP_ID}/appPricePoints?filter[territory]=FRA&limit=200`,
    `apps/${APP_ID}/pricePoints?filter[territory]=FRA&limit=200`,
    `appPricePoints?filter[territory]=FRA&filter[app]=${APP_ID}&limit=200`,
  ];
  for (const path of tries) {
    const { ok, json } = await api("GET", path);
    if (!ok) continue;
    const free = (json.data || []).find(isFree);
    if (free) return free;
    const sample = (json.data || [])
      .slice(0, 3)
      .map((row) => row.attributes?.customerPrice);
    console.log(`Pas de 0.00 dans ${path} (ex: ${sample.join(", ")})`);
  }
  return null;
}

const territories = await allTerritories();
console.log(`Territoires: ${territories.length}`);

const avail = await api("POST", "appAvailabilities", {
  data: {
    type: "appAvailabilities",
    attributes: { availableInNewTerritories: true },
    relationships: {
      app: { data: { type: "apps", id: APP_ID } },
      availableTerritories: {
        data: territories.map((id) => ({ type: "territories", id })),
      },
    },
  },
});
if (!avail.ok) {
  await api("POST", "appAvailabilities", {
    data: {
      type: "appAvailabilityV2",
      attributes: { availableInNewTerritories: true },
      relationships: {
        app: { data: { type: "apps", id: APP_ID } },
        territoryAvailabilities: {
          data: territories.slice(0, 1).map(() => ({
            type: "territoryAvailabilities",
            id: "${t0}",
          })),
        },
      },
    },
    included: territories.map((id, index) => ({
      type: "territoryAvailabilities",
      id: index === 0 ? "${t0}" : `\${t${index}}`,
      attributes: { available: true },
      relationships: {
        territory: { data: { type: "territories", id } },
      },
    })),
  });
}

const free = await freePricePoint();
if (!free) {
  console.error("Aucun palier gratuit trouvé");
  process.exit(1);
}
console.log(`Price point gratuit: ${free.id} (${free.attributes?.customerPrice})`);

const schedule = await api("POST", "appPriceSchedules", {
  data: {
    type: "appPriceSchedules",
    relationships: {
      app: { data: { type: "apps", id: APP_ID } },
      baseTerritory: { data: { type: "territories", id: "FRA" } },
      manualPrices: { data: [{ type: "appPrices", id: "${price0}" }] },
    },
  },
  included: [
    {
      type: "appPrices",
      id: "${price0}",
      attributes: { startDate: null },
      relationships: {
        appPricePoint: { data: { type: "appPricePoints", id: free.id } },
      },
    },
  ],
});

if (!schedule.ok && schedule.status !== 409) {
  process.exit(1);
}
console.log("OK tarif App Store");
