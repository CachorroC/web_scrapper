import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function run() {
  const context = await chromium.launchPersistentContext('/home/cachorro_cami/.config/google-chrome/Default', { headless: true, channel: 'chrome' });
  const page = await context.newPage();
  
  await page.goto('https://www.youtube.com/shorts/5H6k6u84iQ0', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  
  console.log('Clicking comments...');
  const commentsBtn = page.locator('ytd-reel-video-renderer[is-active] #comments-button').first();
  await commentsBtn.click();
  
  await page.waitForTimeout(3000);
  
  console.log('Finding comments panel...');
  const panel = page.locator('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]');
  
  const count = await panel.locator('ytd-comment-thread-renderer').count();
  console.log('Comments loaded:', count);
  
  const scroller = await page.evaluate(() => {
    const el = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"] #item-scroller');
    return el ? el.tagName + '#' + el.id : 'not found';
  });
  console.log('Scroller element:', scroller);

  const title = await page.evaluate(() => {
    const el = document.querySelector('h2.title yt-formatted-string');
    return el ? el.textContent : 'not found title';
  });
  console.log('Title:', title);

  await context.close();
}

run().catch(console.error);
