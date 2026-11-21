import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const locales = ["fr-FR", "en-US"];
const sizes = [
  { dir: "iphone-6.9", width: 440, height: 956, scale: 3 },
  { dir: "iphone-6.7", width: 430, height: 932, scale: 3 },
];
const promoSizes = [
  { dir: "1320x2868", width: 440, height: 956, scale: 3 },
  { dir: "1290x2796", width: 430, height: 932, scale: 3 },
  { dir: "1284x2778", width: 428, height: 926, scale: 3 },
  { dir: "1242x2688", width: 414, height: 896, scale: 3 },
];
const promoBySize = {
  "iphone-6.9": "1320x2868",
  "iphone-6.7": "1290x2796",
};
const promoFiles = ["01_decouverte.png", "02_recherche.png", "03_fiche.png"];
const extraShots = [
  { file: "04_favoris.png", url: "https://www.all-inrent.com/fr/favoris" },
  { file: "05_contact.png", url: "https://www.all-inrent.com/fr/contact" },
];

const nativeInit = () => {
  try {
    localStorage.setItem("air_onboarding_completed", "true");
    document.documentElement.classList.add("air-native-app");
  } catch {}
  const style = document.createElement("style");
  style.textContent = `
    [id*="cookie"], [class*="cookie"], [class*="Cookie"],
    [id*="consent"], [class*="consent"],
    #air-boot-splash { display: none !important; }
    html.air-start-pending { opacity: 1 !important; }
  `;
  document.documentElement.appendChild(style);
};

async function shootPage(page, url, file) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(file.includes("decouverte") ? 4500 : 2800);
  if (file.includes("fiche")) {
    const card = page.locator('a[href*="/vehicules/"]').first();
    if (await card.count()) {
      await card.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(2200);
    }
  }
}

const browser = await chromium.launch({ headless: true });

for (const size of promoSizes) {
  const destDir = path.join(__dirname, "promo", size.dir);
  fs.mkdirSync(destDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.scale,
    isMobile: true,
    hasTouch: true,
    locale: "fr-FR",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) AllInRent/1.0",
  });
  const page = await context.newPage();
  await page.addInitScript(nativeInit);

  const promoShots = [
    { file: "01_decouverte.png", url: "https://www.all-inrent.com/fr", native: false },
    { file: "02_recherche.png", url: "https://www.all-inrent.com/fr/recherche", native: true },
    { file: "03_fiche.png", url: "https://www.all-inrent.com/fr/vehicules/classe-g63", native: true },
  ];
  for (const shot of promoShots) {
    await page.evaluate((useNative) => {
      document.documentElement.classList.toggle("air-native-app", useNative);
    }, shot.native);
    await shootPage(page, shot.url, shot.file);
    const dest = path.join(destDir, shot.file);
    await page.screenshot({
      path: dest,
      type: "png",
      fullPage: false,
      timeout: 15000,
      animations: "disabled",
    });
    console.log(`PROMO ${size.dir}/${shot.file} (${fs.statSync(dest).size} bytes)`);
  }
  await context.close();
}

for (const size of sizes) {
  for (const locale of locales) {
    const destDir = path.join(__dirname, "screenshots", locale);
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of promoFiles) {
      const src = path.join(__dirname, "promo", promoBySize[size.dir], file);
      const dest = path.join(destDir, `${size.dir}_${file}`);
      fs.copyFileSync(src, dest);
      console.log(`COPY ${locale}/${path.basename(dest)}`);
    }
  }
}

for (const size of sizes) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.scale,
    isMobile: true,
    hasTouch: true,
    locale: "fr-FR",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) AllInRent/1.0",
  });
  const page = await context.newPage();
  await page.addInitScript(nativeInit);

  for (const shot of extraShots) {
    await shootPage(page, shot.url, shot.file);
    for (const locale of locales) {
      const destDir = path.join(__dirname, "screenshots", locale);
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, `${size.dir}_${shot.file}`);
      try {
        await page.screenshot({
          path: dest,
          type: "png",
          fullPage: false,
          timeout: 15000,
          animations: "disabled",
        });
        console.log(`OK ${locale}/${path.basename(dest)} (${fs.statSync(dest).size} bytes)`);
      } catch (error) {
        console.warn(`SKIP ${locale}/${path.basename(dest)}: ${error.message}`);
      }
    }
  }
  await context.close();
}

await browser.close();
