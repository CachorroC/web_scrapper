import { chromium, Page } from 'playwright';
import * as xlsx from 'xlsx';
import { writeFile } from 'node:fs/promises';
import { sanitizeFilename } from '../../utils/sanitize_filename.js';
import * as path from 'node:path';
import { userDataDir } from 'utils/assets/user_data_dir.js';

// Define the shape of our extracted comment
interface CommentNode {
  author  : string;
  comment : string;
  time    : string;
  likes   : number;
  replies?: CommentNode[];
}

interface FlatComment {
  ID      : string;
  ParentID: string;
  Author  : string;
  Comment : string;
  Time    : string;
  Likes   : number;
}

/**
 * Helper to flatten nested comments for XLSX export
 */
function flattenComments(
  comments: CommentNode[], parentId: string | null = null 
): FlatComment[] {
  let flat: FlatComment[] = [];
  comments.forEach(
    (
      c, index 
    ) => {
      const currentId = parentId
        ? `${ parentId }.${ index + 1 }`
        : `${ index + 1 }`;
      flat.push(
        {
          ID      : currentId,
          ParentID: parentId || 'ROOT',
          Author  : c.author,
          Comment : c.comment,
          Time    : c.time,
          Likes   : c.likes
        } 
      );

      if ( c.replies && c.replies.length > 0 ) {
        flat = flat.concat(
          flattenComments(
            c.replies, currentId 
          ) 
        );
      }
    } 
  );

  return flat;
}

/**
 * Click "Load more comments" and "View replies" buttons continuously.
 */
async function expandAllComments(
  page: Page 
) {
  console.log(
    'Expanding comments and replies...' 
  );

  const canExpand = true;
  let noChangeCount = 0;

  while ( canExpand && noChangeCount < 5 ) {
    try {
      const loadMoreBtn = page.locator(
        'svg[aria-label="Load more comments"]' 
      ).first();
      const viewRepliesBtn = page.getByText(
        /View replies \(\d+\)/i 
      ).first();
      const viewMoreBtn = page.locator(
        'svg[aria-label="Plus"]' 
      ).first();

      let clicked = false;

      if ( await loadMoreBtn.isVisible(
        {
          timeout: 1000 
        } 
      ) ) {
        await loadMoreBtn.click();
        clicked = true;
      } else if ( await viewRepliesBtn.isVisible(
        {
          timeout: 1000 
        } 
      ) ) {
        await viewRepliesBtn.click();
        clicked = true;
      } else if ( await viewMoreBtn.isVisible(
        {
          timeout: 1000 
        } 
      ) ) {
        await viewMoreBtn.click();
        clicked = true;
      }

      if ( clicked ) {
        await page.waitForTimeout(
          2000 
        );
        noChangeCount = 0;
      } else {
        await page.mouse.wheel(
          0, 300 
        );
        await page.waitForTimeout(
          1000 
        );
        noChangeCount++;
      }
    } catch ( error ) {
      noChangeCount++;
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
): Promise<CommentNode[]> {
  return await page.evaluate(
    () => {
      const commentsResult: CommentNode[] = [];

      // Instagram typically groups a comment and its replies in a single container.
      // For example, a <ul> containing the main <li> and a sub <ul> for replies.
      const commentGroups = document.querySelectorAll(
        'ul.x1qjc9v5' 
      ); // Common list class, fallback to generic ul
      const groupsToProcess = commentGroups.length > 0
        ? commentGroups
        : document.querySelectorAll(
            'ul' 
          );

      groupsToProcess.forEach(
        (
          groupEl 
        ) => {
          // Find the main comment in this group
          const mainCommentEl = groupEl.querySelector(
            'div[role="listitem"], li' 
          );

          if ( !mainCommentEl ) {
            return;
          }

          const extractData = (
            el: Element 
          ): CommentNode | null => {
            const authorEl = el.querySelector(
              'h3, span.xt0psk2, a.x1i10hfl' 
            );
            const author = authorEl && authorEl.textContent
              ? authorEl.textContent.trim()
              : 'Unknown';

            const textEl = el.querySelector(
              'div.x1lliihq > span[dir="auto"], span[dir="auto"]' 
            );
            const text = textEl && textEl.textContent
              ? textEl.textContent.trim()
              : '';

            const timeEl = el.querySelector(
              'time' 
            );
            const time = timeEl
              ? ( timeEl.getAttribute(
                  'title' 
                ) || timeEl.textContent || 'Unknown' )
              : 'Unknown';

            const likesEl = el.querySelector(
              'div.x193iq5w > span' 
            );
            const likesText = likesEl && likesEl.textContent
              ? likesEl.textContent
              : '0';
            const likes = parseInt(
              likesText.replace(
                /\D/g, '' 
              ), 10 
            ) || 0;

            if ( !text || author === 'Unknown' ) {
              return null;
            }

            return {
              author,
              comment: text,
              time,
              likes,
              replies: []
            };
          };

          const mainData = extractData(
            mainCommentEl 
          );

          if ( mainData ) {
            // Look for replies
            const replyElements = groupEl.querySelectorAll(
              'ul div[role="listitem"], ul li' 
            );
            replyElements.forEach(
              (
                replyEl 
              ) => {
                if ( replyEl === mainCommentEl ) {
                  return;
                }

                const replyData = extractData(
                  replyEl 
                );

                if ( replyData && mainData.replies ) {
                  mainData.replies.push(
                    replyData 
                  );
                }
              } 
            );

            commentsResult.push(
              mainData 
            );
          }
        } 
      );

      // Fallback if the group logic didn't catch anything
      if ( commentsResult.length === 0 ) {
        const flatComments = document.querySelectorAll(
          'div[role="listitem"]' 
        );
        flatComments.forEach(
          (
            el 
          ) => {
            const authorEl = el.querySelector(
              'h3, span.xt0psk2, a.x1i10hfl' 
            );
            const author = authorEl && authorEl.textContent
              ? authorEl.textContent.trim()
              : 'Unknown';

            const textEl = el.querySelector(
              'div.x1lliihq > span[dir="auto"], span[dir="auto"]' 
            );
            const text = textEl && textEl.textContent
              ? textEl.textContent.trim()
              : '';

            const timeEl = el.querySelector(
              'time' 
            );
            const time = timeEl
              ? ( timeEl.getAttribute(
                  'title' 
                ) || timeEl.textContent || 'Unknown' )
              : 'Unknown';

            const likesEl = el.querySelector(
              'div.x193iq5w > span' 
            );
            const likesText = likesEl && likesEl.textContent
              ? likesEl.textContent
              : '0';
            const likes = parseInt(
              likesText.replace(
                /\D/g, '' 
              ), 10 
            ) || 0;

            if ( text && author !== 'Unknown' ) {
              commentsResult.push(
                {
                  author,
                  comment: text,
                  time,
                  likes,
                  replies: [] 
                } 
              );
            }
          } 
        );
      }

      return commentsResult;
    } 
  );
}

/**
 * Main Scraper Function
 */
async function scrapeInstagramPost(
  url: string 
) {
  console.log(
    `[Setup] Launching persistent context at: ${ userDataDir }` 
  );
  const context = await chromium.launchPersistentContext(
    userDataDir, {
      headless: false, // Useful for manually solving captchas or login
      channel : 'chrome',
      viewport: {
        width : 1280,
        height: 800 
      }
    } 
  );

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

    // Wait for manual login if required
    console.log(
      'Waiting 20 seconds for manual login or modal dismissal...' 
    );
    await page.waitForTimeout(
      20000 
    );

    // Expand all comments
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
      `\nTotal comments scraped: ${ comments.length }` 
    );

    // Export to JSON and XLSX
    const rawTitle = await page.title();
    const title = rawTitle
      ? rawTitle.substring(
          0, 30 
        )
      : 'instagram_post';
    const safeTitle = sanitizeFilename(
      title 
    );

    const jsonPath = path.resolve(
      `output_${ safeTitle }.json` 
    );
    const xlsxPath = path.resolve(
      `output_${ safeTitle }.xlsx` 
    );

    await writeFile(
      jsonPath, JSON.stringify(
        comments, null, 2 
      ) 
    );
    console.log(
      `Data saved to JSON: ${ jsonPath }` 
    );

    const flatData = flattenComments(
      comments 
    );
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(
      flatData 
    );
    xlsx.utils.book_append_sheet(
      wb, ws, 'Comments' 
    );
    xlsx.writeFile(
      wb, xlsxPath 
    );
    console.log(
      `Data saved to XLSX: ${ xlsxPath }` 
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
const TARGET_URL = 'https://www.instagram.com/reel/DXXakGmCRbM/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA==';
scrapeInstagramPost(
  TARGET_URL 
);
