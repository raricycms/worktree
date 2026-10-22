# Raricy Numeric

A numeric subset of JetBrains Mono 2.304, under the SIL Open Font License 1.1
(the license text is next to these files as `OFL.txt`).

- Coverage: `0123456789#$%+,-./:×‰−` (22 characters), the same range the
  `@font-face` rules in `src/styles/fonts.css` declare.
- Digit `0` (U+0030) uses the original uppercase `O` outline and metrics, so a
  zero in an id, count or timestamp cannot be read as a letter. All other
  retained characters keep their original outlines, hinting and equal advance
  widths.
- Letters and Chinese text in a value that uses `--font-data` fall back to
  JetBrains Mono and the body stack.
- The four WOFF2 files keep regular, bold, italic and bold-italic styling.

The family and its assets are shared with the reference site this project's
visual language is derived from; keep `OFL.txt` alongside the font files when
redistributing.
