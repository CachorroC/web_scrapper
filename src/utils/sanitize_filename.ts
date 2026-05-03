
/**
 * Strips reserved or illegal characters from a string to create a safe file name.
 *
 * **Logic**:
 * Uses a regex to identify characters like `\`, `/`, `*`, `?`, `"`, `<`, `>`, and `|`
 * (which are forbidden in Windows and some other file systems) and replaces them
 * with an empty string. Finally, it trims trailing or leading spaces.
 *
 * @example
 * const safeName = sanitizeFilename("My Video: 100% Awesome? <Look!>");
 * // Returns: "My Video 100% Awesome Look!"
 *
 * @param {string} filename - The original, un-sanitized string.
 * @returns {string} The sanitized string safe for OS file operations.
 */
export function sanitizeFilename(
  filename: string
): string {
  return filename.replace(
    /[\\/*?:"<>|]/g, ''
  ).trim();
}
