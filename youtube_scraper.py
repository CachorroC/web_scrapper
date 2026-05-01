import asyncio
import os
import re
import sys
import pandas as pd
from playwright.async_api import async_playwright
from playwright_stealth import Stealth

def sanitize_filename(filename):
    """Remove invalid characters from a filename."""
    return re.sub(r'[\\/*?:"<>|]', "", filename).strip()

async def get_video_details(page):
    """Extract the video title with multiple selector fallbacks."""
    print("Extracting video title...")
    title_selectors = [
        "h1.style-scope.ytd-watch-metadata",
        "h1.ytd-video-primary-info-renderer",
        "#container h1.ytd-video-primary-info-renderer",
        "yt-formatted-string.ytd-video-primary-info-renderer"
    ]
    
    for selector in title_selectors:
        try:
            element = page.locator(selector)
            if await element.is_visible(timeout=5000):
                title = await element.inner_text()
                if title.strip():
                    return title.strip()
        except Exception:
            continue
            
    # Fallback to page title
    doc_title = await page.title()
    return doc_title.replace(" - YouTube", "").strip()

async def handle_captcha_or_consent(page):
    """Wait for user to handle CAPTCHA or click consent."""
    # Check for common consent buttons
    try:
        consent_selectors = [
            'button:has-text("Accept all")',
            'button:has-text("Aceptar todo")',
            'button:has-text("Agree")',
            'button[aria-label="Accept all"]'
        ]
        for sel in consent_selectors:
            btn = page.locator(sel)
            if await btn.is_visible(timeout=2000):
                await btn.click()
                print("Cookie consent accepted.")
                await page.wait_for_timeout(1000)
                break
    except Exception:
        pass

    # Check for common bot/CAPTCHA screens
    bot_selectors = [
        "iframe[src*='recaptcha']",
        "text=unusual traffic",
        "text=Verify you are human",
        "text=Sign in to confirm you’re not a bot",
        "text=Confirmar que no eres un robot"
    ]
    
    captcha_detected = False
    try:
        for selector in bot_selectors:
            if await page.locator(selector).first.is_visible(timeout=1000):
                captcha_detected = True
                print(f"[!] Detection triggered by: {selector}")
                break
    except Exception:
        pass

    if captcha_detected:
        print("\n[!] CAPTCHA detected or Unusual Traffic detected.")
        print("[!] Please solve the CAPTCHA in the browser window.")
        print("[!] Once solved and the video page is visible, press ENTER in this terminal to continue...")
        await asyncio.to_thread(input)

async def scroll_to_load_comments(page, limit=None):
    """Scroll to load all comments."""
    print("Scrolling to load comments section...")
    
    # Trigger initial load
    await page.evaluate("window.scrollTo(0, 800)")
    await page.wait_for_timeout(3000)
    
    # Wait for comments section
    try:
        await page.wait_for_selector("ytd-comment-thread-renderer", timeout=15000)
        print("Comments section reached.")
    except Exception:
        print("[!] Error: Could not find comments. Maybe solved the CAPTCHA but didn't refresh or scroll?")
        print("[!] Taking a debug screenshot...")
        await page.screenshot(path="debug_error.png")
        return False

    last_height = await page.evaluate("document.documentElement.scrollHeight")
    no_change_count = 0
    
    print("Loading comments (Infinite Scroll)...")
    while True:
        await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
        await page.wait_for_timeout(2500)
        
        new_height = await page.evaluate("document.documentElement.scrollHeight")
        
        count = await page.locator("ytd-comment-thread-renderer").count()
        print(f"  > Loaded ~{count} comment threads...", end="\r")
        
        if limit and count >= limit:
            print(f"\nLimit reached ({limit}).")
            break

        if new_height == last_height:
            no_change_count += 1
            if no_change_count >= 3:
                break
        else:
            last_height = new_height
            no_change_count = 0
            
    print(f"\nFinished scrolling. Total threads: {await page.locator('ytd-comment-thread-renderer').count()}")
    return True

async def extract_comments(page):
    """Extract data from loaded comments using fast JavaScript evaluation."""
    print("Extracting data from DOM...")
    
    # We use evaluate to run JS inside the browser. 
    # This is 100x faster than calling Playwright locators for each field.
    data = await page.evaluate("""() => {
        const results = [];
        const threads = document.querySelectorAll('ytd-comment-thread-renderer');
        
        threads.forEach(thread => {
            const author = thread.querySelector('#author-text')?.innerText || 'Anonymous';
            const text = thread.querySelector('#content-text')?.innerText || '';
            const time = thread.querySelector('yt-formatted-string.published-time-text')?.innerText || 'Unknown';
            const likes = thread.querySelector('#vote-count-middle')?.innerText || '0';
            
            results.push({
                "Author": author.trim(),
                "Comment": text.trim(),
                "Time": time.trim(),
                "Likes": likes.trim() || '0'
            });
        });
        return results;
    }""")
    
    print(f"Extraction complete. Processed {len(data)} comments.")
    return data

async def run_scraper(url, headless=False, limit=None):
    async with async_playwright() as p:
        print(f"Launching browser (headless={headless})...")
        browser = await p.chromium.launch(headless=headless)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 720}
        )
        page = await context.new_page()
        await Stealth().apply_stealth_async(page)
        
        print(f"Navigating to {url}...")
        try:
            await page.goto(url, wait_until="load", timeout=60000)
            await page.wait_for_timeout(3000)
        except Exception as e:
            print(f"Error: {e}")
            await browser.close()
            return

        await handle_captcha_or_consent(page)
        
        video_title = await get_video_details(page)
        print(f"Video Title: {video_title}")
        
        if await scroll_to_load_comments(page, limit):
            comments_data = await extract_comments(page)
            if comments_data:
                df = pd.DataFrame(comments_data)
                filename = sanitize_filename(video_title) + ".xlsx"
                print(f"Saving to {filename}...")
                df.to_excel(filename, index=False)
                print("Done!")
            else:
                print("No comments found.")
        
        await browser.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python youtube_scraper.py <URL> [LIMIT] [--headless]")
        sys.exit(1)
    
    url = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else None
    headless = "--headless" in sys.argv
    
    asyncio.run(run_scraper(url, headless=headless, limit=limit))
