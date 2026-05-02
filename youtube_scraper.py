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

async def expand_all_replies(page):
    """Expand reply threads using Playwright's trusted click events.

    CRITICAL: YouTube's Polymer/LitElement checks event.isTrusted.
      - JS dispatchEvent → isTrusted=false → YouTube silently ignores the click.
      - Playwright ElementHandle.click() → routes through Chrome DevTools Protocol
        input simulation → isTrusted=true → YouTube actually processes the click.

    YouTube DOM (2025): visible "View X replies" button is #more-replies-sub-thread.
    Replies are lazy-rendered, so we do a scroll pass first to hydrate all buttons.
    """
    print("Expanding replies...")

    # Step 1: Slow-scroll all loaded threads to trigger lazy button hydration.
    print("  Scrolling to hydrate reply buttons...")
    scroll_height = await page.evaluate("document.documentElement.scrollHeight")
    pos = 0
    while pos < scroll_height:
        await page.evaluate(f"window.scrollTo(0, {pos})")
        await page.wait_for_timeout(100)
        pos += 600
    await page.evaluate("window.scrollTo(0, 0)")
    await page.wait_for_timeout(1000)

    # Step 2: Click "View X replies" buttons using Playwright's trusted click.
    # query_selector_all() returns a snapshot of ElementHandle objects so DOM
    # mutations during clicking don't shift indices.
    VIEW_BTN = '#more-replies-sub-thread button'
    buttons = await page.query_selector_all(VIEW_BTN)

    if not buttons:
        print("  No 'View replies' buttons found — video may have no replies.")
        return

    print(f"  Found {len(buttons)} 'View replies' button(s). Clicking...")
    clicked = 0
    for btn in buttons:
        try:
            await btn.click(force=True, timeout=1000)
            clicked += 1
        except Exception:
            pass

    print(f"  Clicked {clicked}/{len(buttons)} buttons. Waiting for replies to load...")
    await page.wait_for_timeout(4000)

    # Step 3: Click any "Show more replies" continuation buttons that appeared.
    CONT_BTN = 'ytd-continuation-item-renderer button'
    cont_buttons = await page.query_selector_all(CONT_BTN)
    if cont_buttons:
        print(f"  Found {len(cont_buttons)} 'Show more replies' button(s). Clicking...")
        for btn in cont_buttons:
            try:
                await btn.click(force=True, timeout=1000)
            except Exception:
                pass
        await page.wait_for_timeout(3000)

    print("  Reply expansion complete.")

async def extract_comments(page):
    """Extract data from loaded comments using fast JavaScript evaluation."""
    print("Extracting data from DOM...")
    
    # Expand replies first if possible
    await expand_all_replies(page)
    
    # We use evaluate to run JS inside the browser. 
    # This is 100x faster than calling Playwright locators for each field.
    data = await page.evaluate("""() => {
        const parseLikes = (str) => {
            if (!str) return 0;
            str = str.toLowerCase().replace(/,/g, '').trim();
            let multiplier = 1;
            if (str.includes('k')) {
                multiplier = 1000;
                str = str.replace('k', '');
            } else if (str.includes('m')) {
                multiplier = 1000000;
                str = str.replace('m', '');
            } else if (str.includes('mil')) { // Spanish fallback
                multiplier = 1000;
                str = str.replace('mil', '');
            }
            // Extract numeric part in case of "9.5K likes"
            const match = str.match(/[\\d.]+/);
            if (!match) return 0;
            return Math.floor(parseFloat(match[0]) * multiplier);
        };

        const results = [];
        // Select ALL ytd-comment-thread-renderer elements, but skip any that are
        // nested inside a ytd-comment-replies-renderer — YouTube wraps each reply
        // in its own ytd-comment-thread-renderer, which inflates the count and
        // causes every row to have an empty Replies column.
        const threads = document.querySelectorAll('ytd-comment-thread-renderer');
        
        threads.forEach(thread => {
            // Skip reply threads — only process top-level comment threads
            if (thread.closest('ytd-comment-replies-renderer')) return;

            // Main comment info
            const mainComment = thread.querySelector('#comment');
            if (!mainComment) return;

            const author = mainComment.querySelector('#author-text')?.innerText || 'Anonymous';
            const text = mainComment.querySelector('#content-text')?.innerText || '';
            const time = mainComment.querySelector('yt-formatted-string.published-time-text')?.innerText || 'Unknown';
            const likesText = mainComment.querySelector('#vote-count-middle')?.innerText || '0';
            const likesCount = parseLikes(likesText);
            
            // Collect reply texts.
            // After expansion, YouTube wraps each reply in ytd-comment-thread-renderer
            // inside ytd-comment-replies-renderer. We get the content-text from each.
            const repliesContainer = thread.querySelector('ytd-comment-replies-renderer');
            let replies = [];
            if (repliesContainer) {
                const replyThreads = repliesContainer.querySelectorAll('ytd-comment-thread-renderer');
                if (replyThreads.length > 0) {
                    // Replies are in their own thread renderers (expanded state)
                    replies = Array.from(replyThreads)
                        .map(rt => rt.querySelector('#content-text')?.innerText?.trim() || '')
                        .filter(t => t);
                } else {
                    // Fallback: replies may use ytd-comment-renderer directly
                    const replyRenderers = repliesContainer.querySelectorAll('ytd-comment-renderer');
                    replies = Array.from(replyRenderers)
                        .map(rr => rr.querySelector('#content-text')?.innerText?.trim() || '')
                        .filter(t => t);
                }
            }
            
            results.push({
                "Author": author.trim(),
                "Comment": text.trim(),
                "Time": time.trim(),
                "Likes": likesCount,
                "Replies": replies.join(' | ')
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
        
        # Ensure URL has protocol
        if not url.startswith(("http://", "https://")):
            url = "https://" + url

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
