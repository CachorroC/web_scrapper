import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as xlsx from 'xlsx';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Page } from 'playwright';
import delay from './utils/delay.js';
import { writeFile } from 'node:fs/promises';
import { CommentNode } from './types/yt-comment.js';
import { parseLikes } from './utils/parse_likes.js';
import { sanitizeFilename } from './utils/sanitize_filename.js';

// Apply stealth plugin to avoid basic bot detection
chromium.use(
  StealthPlugin()
);

/**
 * Extracts the primary title of the YouTube video currently loaded in the page.
 *
 * **Logic**:
 * Iterates over a predefined array of common CSS selectors used by YouTube for the video title.
 * For each selector, it checks if the element is visible (with a 5-second timeout).
 * If found, it extracts and returns the inner text. If all selectors fail, it falls
 * back to reading the document `<title>` and stripping the " - YouTube" suffix.
 *
 * @param {Page} page - The active Playwright page instance.
 * @returns {Promise<string>} A promise that resolves to the cleaned video title.
 */
async function getVideoDetails(
  page: Page
): Promise<string> {
  console.log(
    'Extracting video title...'
  );
  const titleSelectors = [
    'h1.style-scope.ytd-watch-metadata',
    'h1.ytd-video-primary-info-renderer',
    '#container h1.ytd-video-primary-info-renderer',
    'yt-formatted-string.ytd-video-primary-info-renderer',
  ];

  for ( const selector of titleSelectors ) {
    try {
      const element = page.locator(
        selector
      ).first();

      if ( await element.isVisible(
        {
          timeout: 5000
        }
      ) ) {
        const title = await element.innerText();

        if ( title.trim() ) {
          return title.trim();
        }
      }
    } catch ( e ) {
      console.log(
        'error catched by the try catch block', e
      );

      continue;
    }
  }

  // Fallback to page title
  const docTitle = await page.title();

  return docTitle.replace(
    ' - YouTube', ''
  ).trim();
}

/**
 * Handles EU/GDPR cookie consent popups and detects bot-verification challenges (CAPTCHA).
 *
 * **Logic**:
 * 1. Checks for various "Accept all" button text variations across different languages.
 *    If found, clicks it to bypass the consent overlay.
 * 2. Checks for known CAPTCHA or "Unusual traffic" iframe sources and text.
 * 3. If a CAPTCHA is detected, it pauses the script using the Node `readline` module,
 *    prompting the user to manually solve the CAPTCHA in the visible browser window
 *    before pressing ENTER to resume execution.
 *
 * @param {Page} page - The active Playwright page instance.
 * @returns {Promise<void>} Resolves when consent is accepted or CAPTCHA is manually bypassed.
 */
async function handleCaptchaOrConsent(
  page: Page
): Promise<void> {
  try {
    const consentSelectors = [
      'button:has-text("Accept all")',
      'button:has-text("Aceptar todo")',
      'button:has-text("Agree")',
      'button[aria-label="Accept all"]',
    ];

    for ( const sel of consentSelectors ) {
      const btn = page.locator(
        sel
      ).first();

      if ( await btn.isVisible(
        {
          timeout: 2000
        }
      ) ) {
        await btn.click();
        console.log(
          'Cookie consent accepted.'
        );
        await delay(
          1000
        );

        break;
      }
    }
  } catch ( e ) {
    console.log(
      'error catched by the try catch block', e
    );
  }

  const botSelectors = [
    'iframe[src*=\'recaptcha\']',
    'text=unusual traffic',
    'text=Verify you are human',
    'text=Sign in to confirm you’re not a bot',
    'text=Confirmar que no eres un robot',
  ];

  let captchaDetected = false;

  try {
    for ( const selector of botSelectors ) {
      if ( await page.locator(
        selector
      ).first().isVisible(
        {
          timeout: 1000
        }
      ) ) {
        captchaDetected = true;
        console.log(
          `[!] Detection triggered by: ${ selector }`
        );

        break;
      }
    }
  } catch ( e ) {
    console.log(
      'error catched by the try catch block', e
    );
  }

  if ( captchaDetected ) {
    console.log(
      '\n[!] CAPTCHA detected or Unusual Traffic detected.'
    );
    console.log(
      '[!] Please solve the CAPTCHA in the browser window.'
    );

    const rl = readline.createInterface(
      {
        input,
        output
      }
    );
    await rl.question(
      '[!] Once solved and the video page is visible, press ENTER in this terminal to continue...'
    );
    rl.close();
  }
}

/**
 * Triggers YouTube's infinite scrolling behavior to load comment threads into the DOM.
 *
 * **Logic**:
 * 1. Does an initial scroll of 800px to trigger the initial loading of the comment section.
 * 2. Waits for the `ytd-comment-thread-renderer` element to appear.
 * 3. Enters an infinite `while(true)` loop:
 *    - Scrolls to the absolute bottom of the document.
 *    - Waits for network/DOM updates.
 *    - Checks the new scroll height against the previous one. If height hasn't changed
 *      for 3 consecutive attempts, it assumes all comments are loaded and breaks the loop.
 *    - Also breaks early if a user-defined `limit` of loaded threads is reached.
 *
 * @param {Page} page - The active Playwright page instance.
 * @param {number | null} [limit=null] - Maximum number of comment threads to load before stopping.
 * @returns {Promise<boolean>} True if successful, false if the comment section couldn't be found.
 */
async function scrollToLoadComments(
  page: Page, limit: number | null = null
): Promise<boolean> {
  console.log(
    'Scrolling to load comments section...'
  );

  await page.evaluate(
    () => {
      return window.scrollTo(
        0, 800
      );
    }
  );
  await delay(
    3000
  );

  try {
    await page.waitForSelector(
      'ytd-comment-thread-renderer', {
        timeout: 15000
      }
    );
    console.log(
      'Comments section reached.'
    );
  } catch ( e ) {
    console.log(
      '[!] Error: Could not find comments. Maybe solved the CAPTCHA but didn\'t refresh or scroll?', e
    );
    console.log(
      '[!] Taking a debug screenshot...', e
    );
    await page.screenshot(
      {
        path: 'debug_error.png'
      }
    );

    return false;
  }

  let lastHeight = await page.evaluate(
    () => {
      return document.documentElement.scrollHeight;
    }
  );
  let noChangeCount = 0;

  console.log(
    'Loading comments (Infinite Scroll)...'
  );

  while ( true ) {
    await page.evaluate(
      () => {
        return window.scrollTo(
          0, document.documentElement.scrollHeight
        );
      }
    );
    await delay(
      2500
    );

    const newHeight = await page.evaluate(
      () => {
        return document.documentElement.scrollHeight;
      }
    );
    const count = await page.locator(
      'ytd-comment-thread-renderer'
    ).count();

    process.stdout.write(
      `  > Loaded ~${ count } comment threads...\r`
    );

    if ( limit && count >= limit ) {
      console.log(
        `\nLimit reached (${ limit }).`
      );

      break;
    }

    if ( newHeight === lastHeight ) {
      noChangeCount += 1;

      if ( noChangeCount >= 3 ) {
        break;
      }
    } else {
      lastHeight = newHeight;
      noChangeCount = 0;
    }
  }

  const finalCount = await page.locator(
    'ytd-comment-thread-renderer'
  ).count();
  console.log(
    `\nFinished scrolling. Total threads: ${ finalCount }`
  );

  return true;
}

/**
 * Finds and clicks all buttons to expand nested replies within comment threads.
 *
 * **Logic**:
 * 1. Scrolls systematically back through the page to force lazy-loaded "View replies" buttons to render.
 * 2. Queries all `#more-replies-sub-thread button` selectors ("View replies").
 * 3. Iterates and clicks each one to trigger the network request for replies.
 * 4. Waits for the replies to load, then looks for `ytd-continuation-item-renderer button`
 *    ("Show more replies") for heavily nested/paginated reply chains, and clicks those as well.
 *
 * @param {Page} page - The active Playwright page instance.
 * @returns {Promise<void>} Resolves when all visible reply buttons have been clicked.
 */
async function expandAllReplies(
  page: Page
): Promise<void> {
  console.log(
    'Expanding replies...'
  );
  console.log(
    '  Scrolling to hydrate reply buttons...'
  );

  const scrollHeight = await page.evaluate(
    () => {
      return document.documentElement.scrollHeight;
    }
  );
  let pos = 0;

  while ( pos < scrollHeight ) {
    await page.evaluate(
      `window.scrollTo(0, ${ pos })`
    );
    await delay(
      100
    );
    pos += 600;
  }

  await page.evaluate(
    () => {
      return window.scrollTo(
        0, 0
      );
    }
  );
  await delay(
    1000
  );

  const VIEW_BTN = '#more-replies-sub-thread button';
  const buttons = await page.$$(
    VIEW_BTN
  );

  if ( buttons.length === 0 ) {
    console.log(
      '  No \'View replies\' buttons found — video may have no replies.'
    );

    return;
  }

  console.log(
    `  Found ${ buttons.length } 'View replies' button(s). Clicking...`
  );
  let clicked = 0;

  for ( const btn of buttons ) {
    try {
      await btn.click(
        {
          force  : true,
          timeout: 1000
        }
      );
      clicked += 1;
    } catch ( e ) {
      console.log(
        'error catched by the try catch block', e
      );
    }
  }

  console.log(
    `  Clicked ${ clicked }/${ buttons.length } buttons. Waiting for replies to load...`
  );
  await delay(
    4000
  );

  const CONT_BTN = 'ytd-continuation-item-renderer button';
  const contButtons = await page.$$(
    CONT_BTN
  );

  if ( contButtons.length > 0 ) {
    console.log(
      `  Found ${ contButtons.length } 'Show more replies' button(s). Clicking...`
    );

    for ( const btn of contButtons ) {
      try {
        await btn.click(
          {
            force  : true,
            timeout: 1000
          }
        );
      } catch ( e ) {
        console.log(
          'error catched by the try catch block', e
        );
      }
    }

    await delay(
      3000
    );
  }

  console.log(
    '  Reply expansion complete.'
  );
}

/**
 * Extracts all visible top-level comments and their nested replies from the DOM.
 *
 * **Logic**:
 * 1. Calls `expandAllReplies()` to ensure DOM nodes for nested comments exist.
 * 2. Uses `page.evaluate()` to run vanilla JavaScript inside the browser context:
 *    - Queries all `ytd-comment-thread-renderer` elements.
 *    - Iterates via classic `for` loops (to prevent Playwright serialization issues).
 *    - Extracts author name, comment text, publish time, and like count for the top-level comment.
 *    - Looks inside the `ytd-comment-replies-renderer` of that thread to parse out nested reply text.
 * 3. Returns the raw scraped array to the Node context.
 * 4. Passes the raw extracted objects through a `.map()` function in Node to format
 *    the keys and run `parseLikes()` on the strings.
 *
 * @param {Page} page - The active Playwright page instance.
 * @returns {Promise<CommentNode[]>} An array of structured comment objects containing text, metadata, and replies.
 */
async function extractComments(
  page: Page
) {
  console.log(
    'Extracting data from DOM...'
  );

  try {
    await expandAllReplies(
      page
    );
  } catch ( e ) {
    console.log(
      `[!] Error expanding replies: ${ e }. Proceeding with extraction of available comments...`
    );
  }

  let finalData: CommentNode[] = [];

  try {
    // 1. Extract pure text strings from the DOM using a clean loop
    const rawData = await page.evaluate(
      () => {
        const results = [];
        const threads = document.querySelectorAll(
          'ytd-comment-thread-renderer'
        );

        // Using classic for-loops instead of .forEach/.map to avoid transpiler interference
        for ( let i = 0; i < threads.length; i++ ) {
          const thread = threads[ i ];

          if ( thread.closest(
            'ytd-comment-replies-renderer'
          ) ) {
            continue;
          }

          const mainComment = thread.querySelector(
            '#comment'
          );

          if ( !mainComment ) {
            continue;
          }

          const authorEl = mainComment.querySelector(
            '#author-text'
          );
          const author = authorEl
            ? ( authorEl as HTMLElement ).innerText
            : 'Anonymous';

          const textEl = mainComment.querySelector(
            '#content-text'
          );
          const text = textEl
            ? ( textEl as HTMLElement ).innerText
            : '';

          const timeEl = mainComment.querySelector(
            'yt-formatted-string.published-time-text'
          );
          const time = timeEl
            ? ( timeEl as HTMLElement ).innerText
            : 'Unknown';

          const likesEl = mainComment.querySelector(
            '#vote-count-middle'
          );
          const likesText = likesEl
            ? ( likesEl as HTMLElement ).innerText
            : '0';

          const repliesContainer = thread.querySelector(
            'ytd-comment-replies-renderer'
          );
          const replies: CommentNode[] = [];

          if ( repliesContainer ) {
            const replyThreads = repliesContainer.querySelectorAll(
              'ytd-comment-thread-renderer'
            );

            if ( replyThreads.length > 0 ) {
              for ( let j = 0; j < replyThreads.length; j++ ) {
                const contentEl = replyThreads[ j ].querySelector(
                  '#content-text'
                );

                if ( contentEl && ( contentEl as HTMLElement ).innerText ) {
                  replies.push(
                    {
                      comment: ( contentEl as HTMLElement ).innerText.trim(),
                      replies: []
                    }
                  );
                }
              }
            } else {
              const replyRenderers = repliesContainer.querySelectorAll(
                'ytd-comment-renderer'
              );

              for ( let k = 0; k < replyRenderers.length; k++ ) {
                const contentEl = replyRenderers[ k ].querySelector(
                  '#content-text'
                );

                if ( contentEl && ( contentEl as HTMLElement ).innerText ) {
                  replies.push(
                    {
                      comment: ( contentEl as HTMLElement ).innerText.trim(),
                      replies: []
                    }
                  );
                }
              }
            }
          }

          results.push(
            {
              Author: author
                ? author.trim()
                : '',
              Comment: text
                ? text.trim()
                : '',
              Time: time
                ? time.trim()
                : '',
              LikesText: likesText,
              Replies  : replies,
            }
          );
        }

        return results;
      }
    );

    // 2. Process the raw strings in the Node environment
    finalData = rawData.map(
      (
        item
      ) => {
        return {
          author : item.Author,
          comment: item.Comment,
          time   : item.Time,
          likes  : parseLikes(
            item.LikesText
          ),
          replies: [
            ...item.Replies
          ],
        };
      }
    );
  } catch ( e ) {
    console.log(
      `[!] Error during DOM evaluation: ${ e }`
    );
  }

  console.log(
    `Extraction complete. Processed ${ finalData.length } comments.`
  );

  return finalData;
}

/**
 * The main orchestration function that drives the entire scraping process.
 *
 * **Flow & Logic**:
 * 1. Launches a persistent Playwright browser context using a predefined user data directory
 *    (to keep sessions/logins alive if needed).
 * 2. Injects a setup script (`addInitScript`) to hijack the History API (`pushState`, `replaceState`).
 *    This prevents YouTube's Single Page Application (SPA) architecture from navigating away
 *    from the target video page accidentally.
 * 3. Navigates to the provided `url`.
 * 4. Solves cookies/captchas (`handleCaptchaOrConsent`).
 * 5. Grabs the video title for file naming (`getVideoDetails`).
 * 6. Triggers lazy loading (`scrollToLoadComments`).
 * 7. Extracts the fully loaded payload (`extractComments`).
 * 8. Maps the JSON data into a flat format and exports it as both `.json` and an `.xlsx` workbook.
 * 9. Cleans up by closing the browser context.
 *
 * @param {string} url - The complete URL of the YouTube video to scrape.
 * @param {boolean} [headless=false] - Whether to run the browser invisibly.
 * @param {number | null} [limit=null] - An optional cap on how many top-level comments to load.
 * @returns {Promise<void>} Resolves when the entire flow finishes and files are saved.
 */
async function runScraper(
  url: string, headless: boolean = false, limit: number | null = null
): Promise<void> {
  console.log(
    `Launching browser (headless=${ headless })...`
  );
  const userDataDir = '/home/cachorro_cami/.config/google-chrome/Default';

  // 1. Pass the viewport details directly into launchPersistentContext
  const context = await chromium.launchPersistentContext(
    userDataDir, {
      headless,
      channel : 'chrome',
      viewport: {
        width : 1280,
        height: 720
      }
    }
  );

  // 2. Grab the default page that opens with launchPersistentContext
  const page = context.pages().length > 0
    ? context.pages()[ 0 ]
    : await context.newPage();

  // Inject script to prevent YouTube SPA routing from messing up the current page context
  await context.addInitScript(
    () => {
      const originalPushState = history.pushState;

      history.pushState = function (
        ...args
      ) {
        const [
          ,, url
        ] = args;

        if ( url && !String(
          url
        ).includes(
          'watch?v='
        ) ) {
          console.log(
            'Blocked SPA navigation to:', url
          );

          return;
        }

        originalPushState.apply(
          this, args
        );
      };

      const originalReplaceState = history.replaceState;

      history.replaceState = function (
        ...args
      ) {
        const [
          ,, url
        ] = args;

        if ( url && !String(
          url
        ).includes(
          'watch?v='
        ) ) {
          console.log(
            'Blocked SPA replace to:', url
          );

          return;
        }

        originalReplaceState.apply(
          this, args
        );
      };

      window.addEventListener(
        'click', (
          e: Event
        ) => {
          const target = e.target as HTMLElement;
          const link = target.closest(
            'a'
          );

          if ( link && link.href ) {
            try {
              const urlObj = new URL(
                link.href, window.location.href
              );

              if ( !urlObj.pathname.startsWith(
                '/watch'
              ) ) {
                e.preventDefault();
                e.stopPropagation();
                console.log(
                  'Blocked click navigation to:', link.href
                );
              }
            } catch ( err ) {
              console.log(
                'error catched by the try catch block', err
              );
            }
          }
        }, true
      );
    }
  );

  if ( !url.startsWith(
    'http://'
  ) && !url.startsWith(
    'https://'
  ) ) {
    url = 'https://' + url;
  }

  console.log(
    `Navigating to ${ url }...`
  );

  try {
    await page.goto(
      url, {
        waitUntil: 'load',
        timeout  : 60000
      }
    );
    await delay(
      3000
    );
  } catch ( e ) {
    console.log(
      `Error: ${ e }`
    );
    await context.close();

    return;
  }

  await handleCaptchaOrConsent(
    page
  );

  const videoTitle = await getVideoDetails(
    page
  );
  console.log(
    `Video Title: ${ videoTitle }`
  );

  try {
    await scrollToLoadComments(
      page, limit
    );
  } catch ( e ) {
    console.log(
      `[!] Error scrolling: ${ e }. Proceeding with extraction of currently loaded comments...`
    );
  }

  const commentsData = await extractComments(
    page
  );

  if ( commentsData && commentsData.length > 0 ) {
    const baseFilename = sanitizeFilename(
      videoTitle
    );
    const excelFilename = baseFilename + '.xlsx';
    const jsonFilename = baseFilename + '.json';

    console.log(
      `Saving to ${ excelFilename } and ${ jsonFilename }...`
    );

    await writeFile(
      jsonFilename, JSON.stringify(
        commentsData, null, 2
      ), 'utf-8'
    );

    const excelData = commentsData.map(
      (
        c
      ) => {
        return {
          Author : c.author,
          Comment: c.comment,
          Time   : c.time,
          Likes  : c.likes,
          Replies: c.replies.map(
            (
              r
            ) => {
              return r.comment;
            }
          ).join(
            ' | '
          ),
        };
      }
    );

    const worksheet = xlsx.utils.json_to_sheet(
      excelData
    );
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(
      workbook, worksheet, 'Comments'
    );
    xlsx.writeFile(
      workbook, excelFilename
    );

    console.log(
      'Done!'
    );
  } else {
    console.log(
      'No comments found.'
    );
  }

  // 3. Change browser.close() to context.close()
  await context.close();
}

// ---------------------------------------------
// CLI Execution Block
// ---------------------------------------------

if ( process.argv.length < 3 ) {
  console.log(
    'Usage: npx tsx scraper.ts <URL> [LIMIT] [--headless]'
  );
  process.exit(
    1
  );
}

const args = process.argv.slice(
  2
);
const [
  targetUrl
] = args;

let limitArg: number | null = null;

if ( args[ 1 ] && !isNaN(
  Number(
    args[ 1 ]
  )
) ) {
  limitArg = parseInt(
    args[ 1 ], 10
  );
}

const isHeadless = args.includes(
  '--headless'
);

runScraper(
  targetUrl, isHeadless, limitArg
).catch(
  console.error
);