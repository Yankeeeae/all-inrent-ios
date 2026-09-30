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

const shots = [
  { file: "01_accueil.png", url: "https://www.all-inrent.com/fr" },
  { file: "02_vehicules.png", url: "https://www.all-inrent.com/fr/vehicules" },
  { file: "03_fiche.png", url: "https://www.all-inrent.com/fr/vehicules" },
  { file: "04_agences.png", url: "https://www.all-inrent.com/fr/agences" },
  { file: "05_contact.png", url: "https://www.all-inrent.com/fr/contact" },
];

const browser = await chromium.launch({ headless: true });

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
  await page.addInitScript(() => {
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
  });

  for (const shot of shots) {
    await page.goto(shot.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2800);
    if (shot.file.includes("fiche")) {
      const card = page.locator('a[href*="/vehicules/"]').first();
      if (await card.count()) {
        await card.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2200);
      }
    }
    for (const locale of locales) {
      const destDir = path.join(__dirname, "screenshots", locale);
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, `${size.dir}_${shot.file}`);
      await page.screenshot({ path: dest, type: "png", fullPage: false });
      console.log(`OK ${locale}/${path.basename(dest)} (${fs.statSync(dest).size} bytes)`);
    }
  }
  await context.close();
}

await browser.close();
