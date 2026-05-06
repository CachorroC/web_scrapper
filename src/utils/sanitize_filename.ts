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
 * Sanitizes a string to ensure it is safe to use as a filename across various operating systems.
 *
 * This function processes the input string through a sequence of normalization and sanitization steps:
 * 1. **Decomposition**: Uses Normalization Form Canonical Decomposition (NFD) to separate base characters from their diacritical marks (e.g., 'á' becomes 'a' + '´').
 * 2. **Accent Removal**: Strips all diacritical marks (Unicode range \u0300-\u036f), effectively converting accented letters to their standard alphabetic equivalents (e.g., á -> a, ñ -> n).
 * 3. **Illegal Character Removal**: Strips characters commonly prohibited or problematic in file paths across Windows, macOS, and Linux (`\`, `/`, `*`, `?`, `:`, `"`, `<`, `>`, `|`), as well as the `#` symbol.
 * 4. **Emoji Removal**: Strips emojis and extended pictographics utilizing Unicode property escapes (`\p{Extended_Pictographic}`).
 * 5. **Trimming**: Removes leading and trailing whitespace to prevent edge spaces from turning into underscores.
 * 6. **Space Substitution**: Replaces all remaining spaces (single or consecutive) with a single underscore (`_`).
 *
 * @param {string} filename - The original, raw string intended to be used as a filename.
 * @returns {string} The cleaned, OS-safe filename string without accents, emojis, illegal characters, or spaces.
 *
 * @example
 * const safeName = sanitizeFilename("My Video: 100% Awesome? 🚀 <Look!>  ");
 * // Returns: "My_Video_100%_Awesome_Look!"
 */
export function sanitizeFilename(
  filename: string
): string {
  return filename
    // 1. Normalize string to separate base letters from diacritics (e.g., 'á' becomes 'a' + '´')
    .normalize(
      'NFD'
    )
    // 2. Remove the diacritic marks (this transforms á->a, é->e, ñ->n, etc.)
    .replace(
      /[\u0300-\u036f]/g, ''
    )
    // 3. Remove illegal OS characters AND the '#' symbol
    .replace(
      /[\\/*?:"<>|#]/g, ''
    )
    // 4. Remove emojis (requires the 'u' flag for unicode matching)
    .replace(
      /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ''
    )
    // 5. Trim outer whitespace first so they don't become underscores
    .trim()
    // 6. Replace single or consecutive spaces with a single underscore
    .replace(
      /\s+/g, '_'
    );
}