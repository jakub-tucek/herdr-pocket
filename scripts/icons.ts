import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  const svg = await readFile("public/icon.svg", "utf8");
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>body{margin:0}svg{width:100vw;height:100vh}</style>${svg}`);
    await page.screenshot({ path: `public/icon-${size}.png` });
    await page.close();
  }
} finally { await browser.close(); }
