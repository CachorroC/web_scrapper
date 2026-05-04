/**
 * @fileoverview Robust YouTube Comment Scraper using Playwright.
 *
 * This script orchestrates a headless/headful browser session to navigate to a YouTube video,
 * bypass GDPR consents, pause for manual CAPTCHA solving if detected, infinitely scroll to
 * load all (or a limited number of) comments, expand deeply nested replies, and extract
 * the resulting data into both JSON and Excel formats.
 *
 * Key architectural principles applied:
 * - Separation of Concerns (SoC): Browser setup, scraping, and file I/O are isolated.
 * - Single Responsibility Principle (SRP): Each function performs exactly one logical task.
 * - Modularity: Helper functions process specific data transformations (e.g., flattening replies).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as xlsx from 'xlsx';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Page, BrowserContext } from 'playwright';
import delay from 'utils/delay.js';
import { writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { CommentNode } from 'types/yt-comment.js';
import { parseLikes } from 'utils/parse_likes.js';
import { sanitizeFilename } from 'utils/sanitize_filename.js';
import { userDataDir } from 'assets/user_data_dir.js';

// Apply stealth plugin to mask automation signatures and avoid basic bot detection
chromium.use(
  StealthPlugin()
);

/**
 * Initializes the persistent browser context and injects Single Page Application (SPA) blockers.
 *
 * **Logic & Flow:**
 * 1. Launches a persistent Chrome context to retain session data (cookies, logins) across runs.
 * 2. Grabs the default open page.
 * 3. Injects a crucial `addInitScript` before the page loads. This script hijacks the browser's
 *    `history.pushState` and `history.replaceState` APIs, as well as global click events.
 *    Because YouTube is a SPA, clicking certain elements can cause the framework to soft-navigate
 *    away from the video context, breaking the scraper. This script forces the browser to ignore
 *    any internal navigation that doesn't include `watch?v=`.
 *
 * @param {boolean} headless - Determines if the browser UI should be visible (false) or hidden (true).
 * @returns {Promise<{ context: BrowserContext; page: Page }>} The initialized browser context and primary active page.
 */
async function setupBrowserContext(
  headless: boolean
): Promise<{ context: BrowserContext; page: Page }> {
  console.log(
    `Launching browser (headless=${ headless })...`
  );

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

  const page = context.pages().length > 0
    ? context.pages()[ 0 ]
    : await context.newPage();

  // Inject script to prevent YouTube SPA routing from navigating away from the target video
  await context.addInitScript(
    () => {
      const originalPushState = history.pushState;

      history.pushState = function (
        ...args
      ) {
        const [
          , , url
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
          , , url
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
                'Error caught by the try/catch block during click interception', err
              );
            }
          }
        }, true
      );
    }
  );

  return {
    context,
    page
  };
}

/**
 * Scrapes the primary title of the currently loaded YouTube video.
 *
 * **Logic:**
 * Iterates through a prioritized array of known CSS selectors that YouTube uses for video titles.
 * It waits briefly for each to become visible. If a selector succeeds, it extracts and sanitizes
 * the text. If all targeted selectors fail (due to A/B testing or UI updates), it falls back to
 * reading the document's `<title>` tag and stripping the universal " - YouTube" suffix.
 *
 * @param {Page} page - The active Playwright page instance containing the loaded video.
 * @returns {Promise<string>} The sanitized video title used later for file naming.
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
        'Selector timeout or failure, moving to next.', e
      );

      continue;
    }
  }

  // Ultimate fallback to the HTML head title
  const docTitle = await page.title();

  return docTitle.replace(
    ' - YouTube', ''
  ).trim();
}

/**
 * Handles automated EU/GDPR cookie consent overlays and monitors for Google bot-detection.
 *
 * **Logic & Flow:**
 * 1. **Consent Bypass:** Scans for localized "Accept all" buttons. If found, clicks to dismiss the overlay.
 * 2. **Bot Detection Check:** Scans the DOM for specific text nodes or iframes indicating a reCAPTCHA
 *    or an "Unusual traffic" block.
 * 3. **Manual Intervention:** If a block is detected, execution halts. It leverages Node's `readline`
 *    to prompt the user in the terminal. The user must manually solve the CAPTCHA in the visible
 *    browser window, then press ENTER in the terminal to resume the script.
 *
 * @param {Page} page - The active Playwright page instance.
 * @returns {Promise<void>} Resolves once the page is clear of overlays or manually unblocked.
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
      'Error during cookie consent handling', e
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
      'Error during CAPTCHA detection phase', e
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
 * Forces YouTube's lazy-loading engine to fetch all comment threads via infinite scrolling.
 *
 * **Logic & Flow:**
 * 1. Performs an initial 800px scroll to trigger the XHR request that loads the comment section container.
 * 2. Enters an infinite `while` loop, continuously scrolling to the `document.documentElement.scrollHeight`.
 * 3. Compares the total height and the count of `<ytd-comment-thread-renderer>` nodes before and after scrolling.
 * 4. **Exit Conditions:**
 *    - The node count meets or exceeds the user-defined `limit`.
 *    - The DOM height or node count remains unchanged for several consecutive iterations (indicating the absolute bottom has been reached).
 *
 * @param {Page} page - The active Playwright page instance.
 * @param {number | null} [limit=null] - Optional ceiling for the number of top-level threads to load.
 * @returns {Promise<boolean>} True if scrolling completed successfully, False if comments failed to load entirely.
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
  let lastCommentCount = 0;
  let noCommentChangeCount = 0;

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

    if ( count === lastCommentCount ) {
      noCommentChangeCount += 1;

      if ( noCommentChangeCount >= 5 ) {
        break;
      }
    } else {
      lastCommentCount = count;
      noCommentChangeCount = 0;
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
 * Locates and clicks all UI elements required to expand hidden nested replies.
 *
 * **Logic & Flow:**
 * 1. Re-scrolls the page from top to bottom. Because YouTube unmounts off-screen elements
 *    (virtualized lists) to save memory, this "re-hydrates" the DOM nodes.
 * 2. Queries all initial "View replies" buttons (`#more-replies-sub-thread button`) and clicks them.
 * 3. Waits for the network requests to resolve, then searches for subsequent pagination buttons
 *    ("Show more replies" - `ytd-continuation-item-renderer button`) inside heavily nested threads and clicks them.
 *
 * @param {Page} page - The active Playwright page instance.
 * @returns {Promise<void>} Resolves when all visible expansion buttons have been processed.
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

  // Systematic slow scroll to force rendering of lazy-loaded buttons
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
        e
      );
      // Catch individual button failures silently to maintain the loop
    }
  }

  console.log(
    `  Clicked ${ clicked }/${ buttons.length } buttons. Waiting for replies to load...`
  );
  await delay(
    4000
  );

  // Check for secondary "Show more replies" buttons
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
          e
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
 * Core scraping engine: extracts text and metadata from the loaded DOM and builds a structured object tree.
 *
 * **Logic & Flow:**
 * 1. Injects a vanilla JavaScript function directly into the browser context via `page.evaluate()`.
 *    - Note: Classic `for` loops are used here instead of `.map()` or `.forEach()`. Playwright's serialization
 *      pipeline can struggle with complex iterator callbacks when passing data across the Node/Browser boundary.
 * 2. Parses the main comment node for Author, Text, Time, and Vote Count.
 * 3. Scans for an attached `<ytd-comment-replies-renderer>` and extracts any child replies.
 * 4. Passes this raw, flat dictionary array back to Node.js.
 * 5. In Node, maps over the raw data to clean it up. Uses a regex (`/^@([^\s,:]+)/`) to detect "@mentions"
 *    in replies, allowing it to artificially rebuild deeply nested conversational threads even though
 *    YouTube renders them in a flat list visually.
 *
 * @param {Page} page - The active Playwright page instance containing the hydrated comments.
 * @returns {Promise<CommentNode[]>} An array of fully structured, nested comment objects.
 */
async function extractComments(
  page: Page
): Promise<CommentNode[]> {
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
    // 1. Extract pure text strings from the DOM using a browser-context script
    const rawData = await page.evaluate(
      () => {
        const results = [];
        const threads = document.querySelectorAll(
          'ytd-comment-thread-renderer'
        );

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
            '#published-time-text'
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
          const replies: any[] = [];

          if ( repliesContainer ) {
            const replyThreads = repliesContainer.querySelectorAll(
              'ytd-comment-thread-renderer'
            );

            if ( replyThreads.length > 0 ) {
              for ( let j = 0; j < replyThreads.length; j++ ) {
                const el = replyThreads[ j ];
                const contentEl = el.querySelector(
                  '#content-text'
                );
                const authorEl = el.querySelector(
                  '#author-text'
                );
                const timeEl = el.querySelector(
                  '#published-time-text'
                );
                const likesEl = el.querySelector(
                  '#vote-count-middle'
                );

                if ( contentEl && ( contentEl as HTMLElement ).innerText ) {
                  replies.push(
                    {
                      Author: authorEl
                        ? ( authorEl as HTMLElement ).innerText.trim()
                        : 'Anonymous',
                      Comment: ( contentEl as HTMLElement ).innerText.trim(),
                      Time   : timeEl
                        ? ( timeEl as HTMLElement ).innerText.trim()
                        : 'Unknown',
                      LikesText: likesEl
                        ? ( likesEl as HTMLElement ).innerText.trim()
                        : '0',
                      Replies: []
                    }
                  );
                }
              }
            } else {
              const replyRenderers = repliesContainer.querySelectorAll(
                'ytd-comment-renderer'
              );

              for ( let k = 0; k < replyRenderers.length; k++ ) {
                const el = replyRenderers[ k ];
                const contentEl = el.querySelector(
                  '#content-text'
                );
                const authorEl = el.querySelector(
                  '#author-text'
                );
                const timeEl = el.querySelector(
                  '#published-time-text'
                );
                const likesEl = el.querySelector(
                  '#vote-count-middle'
                );

                if ( contentEl && ( contentEl as HTMLElement ).innerText ) {
                  replies.push(
                    {
                      Author: authorEl
                        ? ( authorEl as HTMLElement ).innerText.trim()
                        : 'Anonymous',
                      Comment: ( contentEl as HTMLElement ).innerText.trim(),
                      Time   : timeEl
                        ? ( timeEl as HTMLElement ).innerText.trim()
                        : 'Unknown',
                      LikesText: likesEl
                        ? ( likesEl as HTMLElement ).innerText.trim()
                        : '0',
                      Replies: []
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

    // 2. Process the raw strings in the Node environment (Typing, Parsers, and Nesting logic)
    finalData = rawData.map(
      (
        item
      ) => {
        const nestedReplies: CommentNode[] = [];
        const previousNodes: CommentNode[] = [];

        for ( const rawReply of item.Replies ) {
          const replyNode: CommentNode = {
            author : rawReply.Author || 'Anonymous',
            comment: rawReply.Comment || rawReply.comment || '',
            time   : rawReply.Time || 'Unknown',
            likes  : parseLikes(
              rawReply.LikesText || '0'
            ),
            replies: []
          };

          const cleanComment = replyNode.comment.replace(
            /^[\s\u200B-\u200D\uFEFF]+/, ''
          );
          const mentionMatch = cleanComment.match(
            /^@([^\s,:]+)/
          );
          let placed = false;

          // Mention resolution block: Attaches replies to the specific user they tagged
          if ( mentionMatch ) {
            const [
              , mentionedUser
            ] = mentionMatch;
            let parentNode: CommentNode | undefined;

            const normalizeName = (
              name: string
            ) => {
              return name.replace(
                /[^a-zA-Z0-9]/g, ''
              ).toLowerCase();
            };

            const cleanMention = normalizeName(
              mentionedUser
            );

            for ( let i = previousNodes.length - 1; i >= 0; i-- ) {
              const prevNode = previousNodes[ i ];
              const cleanAuthor = normalizeName(
                prevNode.author
              );

              if ( cleanAuthor && cleanMention && ( cleanAuthor === cleanMention || cleanAuthor.includes(
                cleanMention
              ) || cleanMention.includes(
                cleanAuthor
              ) ) ) {
                parentNode = prevNode;

                break;
              }
            }

            if ( parentNode ) {
              parentNode.replies!.push(
                replyNode
              );
              placed = true;
            }
          }

          if ( !placed ) {
            nestedReplies.push(
              replyNode
            );
          }

          previousNodes.push(
            replyNode
          );
        }

        return {
          author : item.Author,
          comment: item.Comment,
          time   : item.Time,
          likes  : parseLikes(
            item.LikesText
          ),
          replies: nestedReplies,
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

// ---------------------------------------------
// File I/O Modules
// ---------------------------------------------

/**
 * Validates the existence of a local `logs` directory, creating it if absent.
 * @returns {Promise<string>} The absolute path to the logs directory.
 */
async function ensureLogsDirectory(): Promise<string> {
  const logsDir = path.join(
    process.cwd(), 'logs'
  );
  await mkdir(
    logsDir, {
      recursive: true
    }
  );

  return logsDir;
}

/**
 * Writes the structured comment tree to disk as a JSON file.
 * @param {CommentNode[]} data - The fully structured comment data.
 * @param {string} filename - The absolute destination file path.
 */
async function saveDataAsJson(
  data: CommentNode[], filename: string
): Promise<void> {
  await writeFile(
    filename, JSON.stringify(
      data, null, 2
    ), 'utf-8'
  );
}

/**
 * Recursively unwraps nested reply threads into a flat, 1-dimensional array of strings.
 * This is required because Excel rows are fundamentally flat and cannot easily represent deep nesting.
 *
 * @param {CommentNode[]} replies - The array of child replies.
 * @returns {string[]} A flat array of all reply text in the tree.
 */
function flattenReplies(
  replies: CommentNode[]
): string[] {
  let list: string[] = [];

  for ( const r of replies ) {
    list.push(
      r.comment
    );

    if ( r.replies && r.replies.length > 0 ) {
      list = list.concat(
        flattenReplies(
          r.replies
        )
      );
    }
  }

  return list;
}

/**
 * Converts the nested comment object into a flat tabular format and saves it as an `.xlsx` file.
 *
 * @param {CommentNode[]} data - The structured comment tree.
 * @param {string} filename - The absolute destination file path.
 */
function saveDataAsExcel(
  data: CommentNode[], filename: string
): void {
  const excelData = data.map(
    (
      c
    ) => {
      return {
        Author : c.author,
        Comment: c.comment,
        Time   : c.time,
        Likes  : c.likes,
        Replies: flattenReplies(
          c.replies || []
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
    workbook, filename
  );
}

// ---------------------------------------------
// Core Orchestrator
// ---------------------------------------------

/**
 * Master controller that orchestrates the discrete functional modules into a sequential execution pipeline.
 *
 * **Pipeline Flow:**
 * 1. **Init:** Calls `setupBrowserContext` to boot Playwright.
 * 2. **Navigation:** Validates the URL protocol and triggers Playwright to load the page.
 * 3. **Bypass:** Triggers `handleCaptchaOrConsent` to clear the view.
 * 4. **Meta Extraction:** Fetches the title via `getVideoDetails` for future I/O operations.
 * 5. **Hydration:** Engages `scrollToLoadComments` to fetch the raw DOM nodes.
 * 6. **Scraping:** Triggers `extractComments` (which internally calls `expandAllReplies`) to parse the DOM.
 * 7. **I/O Storage:** Validates directories and triggers `saveDataAsJson` and `saveDataAsExcel`.
 * 8. **Teardown:** Safely destroys the browser context.
 *
 * @param {string} url - The target YouTube video URL.
 * @param {boolean} [headless=false] - Execution mode (visible vs invisible).
 * @param {number | null} [limit=null] - Maximum threads to parse.
 * @returns {Promise<void>} Resolves when the entire pipeline is complete and the context is closed.
 */
async function runScraper(
  url: string, headless: boolean = false, limit: number | null = null
): Promise<void> {

  // 1. Setup Browser
  const {
    context, page
  } = await setupBrowserContext(
    headless
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
      `Error navigating to URL: ${ e }`
    );
    await context.close();

    return;
  }

  // 2. Handle Consent and Extract Data
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

  // 3. Handle File Saving
  if ( commentsData && commentsData.length > 0 ) {
    const baseFilename = sanitizeFilename(
      videoTitle
    );
    const logsDir = await ensureLogsDirectory();

    const excelFilename = path.join(
      logsDir, `${ baseFilename }.xlsx`
    );
    const jsonFilename = path.join(
      logsDir, `${ baseFilename }.json`
    );

    console.log(
      `Saving to ${ excelFilename } and ${ jsonFilename }...`
    );

    await saveDataAsJson(
      commentsData, jsonFilename
    );
    saveDataAsExcel(
      commentsData, excelFilename
    );

    console.log(
      'Done!'
    );
  } else {
    console.log(
      'No comments found.'
    );
  }

  // 4. Teardown
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

console.log(
  limitArg
);
const isHeadless = args.includes(
  '--headless'
);

runScraper(
  targetUrl, isHeadless, limitArg
).catch(
  console.error
);