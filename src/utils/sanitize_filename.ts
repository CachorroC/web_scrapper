/**
 * Strips reserved or illegal characters and emojis from a string,
 * and replaces spaces with underscores to create a safe file name.
 *
 * **Logic**:
 * - Uses a regex to identify characters like `\`, `/`, `*`, `?`, `"`, `<`, `>`, and `|`
 *   (which are forbidden in Windows and some other file systems) and removes them.
 * - Uses a Unicode property escape regex to identify and remove emojis.
 * - Trims trailing or leading spaces to prevent edge underscores.
 * - Replaces remaining spaces (or consecutive spaces) with a single underscore.
 *
 * @example
 * const safeName = sanitizeFilename("My Video: 100% Awesome? 🚀 <Look!>  ");
 * // Returns: "My_Video_100%_Awesome_Look!"
 *
 * @param {string} filename - The original, un-sanitized string.
 * @returns {string} The sanitized string safe for OS file operations.
 */
export function sanitizeFilename(
  filename: string
): string {
  return filename
    // 1. Remove illegal OS characters
    .replace(
      /[\\/*?:"<>|]/g, ''
    )
    // 2. Remove emojis (requires the 'u' flag for unicode matching)
    .replace(
      /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ''
    )
    // 3. Trim outer whitespace first so they don't become underscores
    .trim()
    // 4. Replace single or consecutive spaces with a single underscore
    .replace(
      /\s+/g, '_'
    );
}
