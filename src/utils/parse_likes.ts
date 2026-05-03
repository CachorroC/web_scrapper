
/**
 * Converts a YouTube-style like count string into a numeric integer.
 *
 * **Logic**:
 * 1. Returns 0 if the string is null/empty.
 * 2. Normalizes the string to lowercase and removes commas (e.g., "1,000" -> "1000").
 * 3. Identifies multipliers based on suffixes ('k' = 1000, 'm' / 'mil' = 1000000).
 * 4. Extracts the numerical portion using a regex.
 * 5. Multiplies the base number by the multiplier and floors it to ensure an integer.
 *
 * @example
 * parseLikes("1.5K") // Returns: 1500
 * parseLikes("2M")   // Returns: 2000000
 * parseLikes("45")   // Returns: 45
 * parseLikes(null)   // Returns: 0
 *
 * @param {string | null} str - The raw like count string scraped from the DOM.
 * @returns {number} The integer representation of the likes.
 */
export function parseLikes(
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
