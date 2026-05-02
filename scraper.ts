import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as xlsx from 'xlsx';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import type { Page } from 'playwright';

// Apply stealth plugin
chromium.use(
  StealthPlugin() 
);

/** Utility to replace Playwright's deprecated waitForTimeout */
const delay = (
  ms: number 
) => {
  return new Promise(
    (
      resolve 
    ) => {
      return setTimeout(
        resolve, ms 
      );
    } 
  );
};

function sanitizeFilename(
  filename: string 
): string {
  return filename.replace(
    /[\\/*?:"<>|]/g, '' 
  ).trim();
}

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
      continue;
    }
  }

  // Fallback to page title
  const docTitle = await page.title();

  return docTitle.replace(
    ' - YouTube', '' 
  ).trim();
}

async function handleCaptchaOrConsent(
  page: Page
): Promise<void> {
  // Check for common consent buttons
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
    // Ignore
  }

  // Check for common bot/CAPTCHA screens
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
      if (
        await page
          .locator(
            selector 
          )
          .first()
          .isVisible(
            {
              timeout: 1000 
            } 
          )
      ) {
        captchaDetected = true;
        console.log(
          `[!] Detection triggered by: ${ selector }`
        );

        break;
      }
    }
  } catch ( e ) {
    // Ignore
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

async function scrollToLoadComments(
  page: Page,
  limit: number | null = null
): Promise<boolean> {
  console.log(
    'Scrolling to load comments section...' 
  );

  // Trigger initial load
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

  // Wait for comments section
  try {
    await page.waitForSelector(
      'ytd-comment-thread-renderer',
      {
        timeout: 15000 
      }
    );
    console.log(
      'Comments section reached.' 
    );
  } catch ( e ) {
    console.log(
      '[!] Error: Could not find comments. Maybe solved the CAPTCHA but didn\'t refresh or scroll?'
    );
    console.log(
      '[!] Taking a debug screenshot...' 
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
          0,
          document.documentElement.scrollHeight
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
    const count = await page
      .locator(
        'ytd-comment-thread-renderer' 
      )
      .count();

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

  const finalCount = await page
    .locator(
      'ytd-comment-thread-renderer' 
    )
    .count();
  console.log(
    `\nFinished scrolling. Total threads: ${ finalCount }`
  );

  return true;
}

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
      // Ignore
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
        // Ignore
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

async function extractComments(
  page: Page 
): Promise<any[]> {
  console.log(
    'Extracting data from DOM...' 
  );

  await expandAllReplies(
    page 
  );

  const data = await page.evaluate(
    () => {
      const parseLikes = (
        str: string | null 
      ): number => {
        if ( !str ) {
          return 0;
        }

        str = str.toLowerCase().replace(
          /,/g, '' 
        ).trim();
        let multiplier = 1;

        if ( str.includes(
          'k' 
        ) ) {
          multiplier = 1000;
          str = str.replace(
            'k', '' 
          );
        } else if ( str.includes(
          'm' 
        ) ) {
          multiplier = 1000000;
          str = str.replace(
            'm', '' 
          );
        } else if ( str.includes(
          'mil' 
        ) ) {
          multiplier = 1000;
          str = str.replace(
            'mil', '' 
          );
        }

        const match = str.match(
          /[\d.]+/ 
        );

        if ( !match ) {
          return 0;
        }

        return Math.floor(
          parseFloat(
            match[ 0 ] 
          ) * multiplier 
        );
      };

      const results: any[] = [];
      const threads = document.querySelectorAll(
        'ytd-comment-thread-renderer'
      );

      threads.forEach(
        (
          thread 
        ) => {
          if ( thread.closest(
            'ytd-comment-replies-renderer' 
          ) ) {
            return;
          }

          const mainComment = thread.querySelector(
            '#comment' 
          );

          if ( !mainComment ) {
            return;
          }

          const author
            = (
              mainComment.querySelector(
                '#author-text'
              ) as HTMLElement
            )?.innerText || 'Anonymous';
          const text
            = (
              mainComment.querySelector(
                '#content-text'
              ) as HTMLElement
            )?.innerText || '';
          const time
            = (
              mainComment.querySelector(
                'yt-formatted-string.published-time-text'
              ) as HTMLElement
            )?.innerText || 'Unknown';
          const likesText
            = (
              mainComment.querySelector(
                '#vote-count-middle'
              ) as HTMLElement
            )?.innerText || '0';
          const likesCount = parseLikes(
            likesText 
          );

          const repliesContainer = thread.querySelector(
            'ytd-comment-replies-renderer'
          );
          let replies: string[] = [];

          if ( repliesContainer ) {
            const replyThreads
              = repliesContainer.querySelectorAll(
                'ytd-comment-thread-renderer'
              );

            if ( replyThreads.length > 0 ) {
              replies = Array.from(
                replyThreads 
              )
                .map(
                  (
                    rt 
                  ) => {
                    return (
                      rt.querySelector(
                        '#content-text'
                      ) as HTMLElement
                    )?.innerText?.trim() || '';
                  }
                )
                .filter(
                  (
                    t 
                  ) => {
                    return t;
                  } 
                );
            } else {
              const replyRenderers
                = repliesContainer.querySelectorAll(
                  'ytd-comment-renderer'
                );
              replies = Array.from(
                replyRenderers 
              )
                .map(
                  (
                    rr 
                  ) => {
                    return (
                      rr.querySelector(
                        '#content-text'
                      ) as HTMLElement
                    )?.innerText?.trim() || '';
                  }
                )
                .filter(
                  (
                    t 
                  ) => {
                    return t;
                  } 
                );
            }
          }

          results.push(
            {
              Author : author.trim(),
              Comment: text.trim(),
              Time   : time.trim(),
              Likes  : likesCount,
              Replies: replies.join(
                ' | ' 
              ),
            } 
          );
        } 
      );

      return results;
    } 
  );

  console.log(
    `Extraction complete. Processed ${ data.length } comments.`
  );

  return data;
}

async function runScraper(
  url: string,
  headless: boolean = false,
  limit: number | null = null
): Promise<void> {
  console.log(
    `Launching browser (headless=${ headless })...`
  );

  const browser = await chromium.launch(
    {
      headless 
    } 
  );
  const context = await browser.newContext(
    {
      viewport: {
        width : 1280,
        height: 720 
      },
    } 
  );
  const page = await context.newPage();

  if (
    !url.startsWith(
      'http://' 
    )
    && !url.startsWith(
      'https://' 
    )
  ) {
    url = 'https://' + url;
  }

  console.log(
    `Navigating to ${ url }...` 
  );

  try {
    await page.goto(
      url, {
        waitUntil: 'load',
        timeout  : 60000,
      } 
    );
    await delay(
      3000 
    );
  } catch ( e ) {
    console.log(
      `Error: ${ e }` 
    );
    await browser.close();

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

  const success = await scrollToLoadComments(
    page, limit 
  );

  if ( success ) {
    const commentsData = await extractComments(
      page 
    );

    if ( commentsData && commentsData.length > 0 ) {
      const filename
        = sanitizeFilename(
          videoTitle 
        ) + '.xlsx';
      console.log(
        `Saving to ${ filename }...` 
      );

      // Create Excel workbook and sheet
      const worksheet
        = xlsx.utils.json_to_sheet(
          commentsData 
        );
      const workbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(
        workbook,
        worksheet,
        'Comments'
      );
      xlsx.writeFile(
        workbook, filename 
      );

      console.log(
        'Done!' 
      );
    } else {
      console.log(
        'No comments found.' 
      );
    }
  }

  await browser.close();
}

// CLI Execution
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
const targetUrl = args[ 0 ];

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
