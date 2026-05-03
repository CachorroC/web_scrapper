import { chromium, Page } from 'playwright';
import { userDataDir } from 'assets/user_data_dir.js';


interface Comment {
  author       : string;
  text         : string;
  interactions?: string;
  replies      : Comment[];
}

/**
 * Helper function to continuously click buttons (like "View more comments" or "See more")
 * until they no longer appear on the page.
 */
async function expandAllComments(
  page: Page
) {
  console.log(
    'Expanding comments and replies...'
  );

  let canExpand = true;

  while ( canExpand ) {
    try {
      // Look for common Facebook expansion buttons by text/role
      const expandButton = page.getByRole(
        'button', {
          name: /View \d+ more comments|View more comments|See more|View \d+ replies|View previous comments/i
        }
      ).first();

      // Check if the button is currently visible and attached
      if ( await expandButton.isVisible(
        {
          timeout: 2000
        }
      ) ) {
        await expandButton.click();
        // Wait a moment for the network request and DOM update to finish
        await page.waitForTimeout(
          1500
        );
      } else {
        canExpand = false;
      }
    } catch ( error ) {
      console.log(
        'error catched by the try catch block', error
      );
      // If we timeout or element detaches, we assume we've expanded everything
      canExpand = false;
    }
  }

  console.log(
    'Finished expanding comments.'
  );
}

/**
 * Core scraping logic to extract data from the loaded DOM.
 */
async function extractCommentsData(
  page: Page
): Promise<Comment[]> {
  return await page.evaluate(
    () => {
      const commentsResult: Comment[] = [];

      // Facebook typically wraps comments in divs with role="article"
      // Note: This targets top-level comments and their nested structure
      const commentElements = document.querySelectorAll(
        'div[role="article"]'
      );

      commentElements.forEach(
        (
          commentEl
        ) => {
          // Check if this is a top-level comment by looking at its nesting depth
          // (FB DOM structures change, so this is a best-effort heuristic based on standard layouts)
          const ariaLabel = commentEl.getAttribute(
            'aria-label'
          );

          if ( !ariaLabel || !ariaLabel.toLowerCase().includes(
            'comment by'
          ) ) {
            return;
          }

          // Extract Author
          const authorMatch = ariaLabel.match(
            /Comment by (.*?)(?:$| on)/
          );
          const author = authorMatch
            ? authorMatch[ 1 ]
            : 'Unknown';

          // Extract Text (usually the deepest span or div with actual text direction ltr)
          // We look for elements with dir="auto" which FB uses for user text
          const textElement = commentEl.querySelector(
            'div[dir="auto"]'
          );
          const text = textElement && textElement.textContent
            ? textElement.textContent
            : '';

          // Extract Interactions (Likes, Reactions)
          // Typically found in a toolbar or a specific link next to "Reply"
          const interactionLink = commentEl.querySelector(
            'a[href*="/ufi/reaction/"]'
          );
          const interactions = interactionLink && interactionLink.textContent
            ? interactionLink.textContent
            : '0';

          // If we successfully found text, format it
          if ( text ) {
            // Determine if this is a reply by checking its DOM depth relative to a main comment
            // For simplicity in this raw DOM extraction, we are collecting them flat,
            // but you can nest them by looking at sibling grouping in the specific FB layout.
            commentsResult.push(
              {
                author,
                text,
                interactions,
                replies: [] // In a highly robust script, you would recursively parse nested 'ul' or sibling reply blocks here
              }
            );
          }
        }
      );

      return commentsResult;
    }
  );
}

/**
 * Main Scraper Function
 */
async function scrapeFacebookPost(
  url: string
) {


  console.log(
    `[Setup] Launching persistent context at: ${ userDataDir }`
  );
  // Launch browser in non-headless mode so you can handle captchas or login walls
  const context = await chromium.launchPersistentContext(
    userDataDir,
    {
      headless: false,
      channel : 'chrome',
      viewport: {
        width : 1280,
        height: 800
      }
    }
  );

  // Set a consistent locale to ensure text matching (like "View more comments") works


  const page = await context.newPage();

  try {
    console.log(
      `Navigating to ${ url }...`
    );
    await page.goto(
      url, {
        waitUntil: 'domcontentloaded'
      }
    );

    // Facebook will almost certainly prompt for a login to see full comments.
    // We pause the script here for 20 seconds. Use this time to manually log in if a modal appears,
    // or dismiss the bottom banner.
    console.log(
      'Waiting 20 seconds for manual login or modal dismissal...'
    );
    await page.waitForTimeout(
      20000
    );

    // Scroll a bit to trigger lazy loading of the comment section
    await page.mouse.wheel(
      0, 500
    );
    await page.waitForTimeout(
      2000
    );

    // Expand all the "See more" and "Reply" threads
    await expandAllComments(
      page
    );

    // Extract the data
    console.log(
      'Extracting comment data...'
    );
    const comments = await extractCommentsData(
      page
    );

    console.log(
      '\n--- Extraction Complete ---'
    );
    console.log(
      JSON.stringify(
        comments, null, 2
      )
    );

    console.log(
      `\nTotal comments/replies scraped: ${ comments.length }`
    );

  } catch ( error ) {
    console.error(
      'An error occurred during scraping:', error
    );
  } finally {
    await context.close();
  }
}

// Execute the script with the provided URL
const TARGET_URL = 'https://www.facebook.com/share/p/1KR4Sp1WJJ/';
scrapeFacebookPost(
  TARGET_URL
);