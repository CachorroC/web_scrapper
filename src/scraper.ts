import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as xlsx from 'xlsx';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Page } from 'playwright';
import delay from './utils/delay.js';

// Apply stealth plugin
chromium.use(
  StealthPlugin()
);

function sanitizeFilename(
  filename: string
): string {
  return filename.replace(
    /[\\/*?:"<>|]/g, ''
  ).trim();
}

/**
 * Moved outside the browser context.
 * Node.js will handle parsing the likes safely.
 */
function parseLikes(
  str: string | null
): number {
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

  let finalData: {
    Author : string;
    Comment: string;
    Time   : string;
    Likes  : number;
    Replies: string;
  }[] = [];

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
          const replies = [];

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
                    ( contentEl as HTMLElement ).innerText.trim()
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
                    ( contentEl as HTMLElement ).innerText.trim()
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
              Replies  : replies.join(
                ' | '
              ),
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
          Author : item.Author,
          Comment: item.Comment,
          Time   : item.Time,
          Likes  : parseLikes(
            item.LikesText
          ),
          Replies: item.Replies,
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
    // Change browser.close() to context.close()
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
    const filename = sanitizeFilename(
      videoTitle
    ) + '.xlsx';
    console.log(
      `Saving to ${ filename }...`
    );

    const worksheet = xlsx.utils.json_to_sheet(
      commentsData
    );
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(
      workbook, worksheet, 'Comments'
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

  // 3. Change browser.close() to context.close()
  await context.close();
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