export default {
  defaultSeverity: 'error',
  extends: ['stylelint-config-standard', 'stylelint-config-html/svelte'],
  ignoreFiles: ['.svelte-kit/**', 'dist/**', 'node_modules/**', 'src/generated/**'],
  plugins: ['stylelint-order', 'stylelint-plugin-defensive-css', 'stylelint-use-logical'],
  rules: {
    // Keep CSS structurally simple
    'max-nesting-depth': 2,
    'selector-max-combinators': 3,
    'declaration-no-important': true,
    'color-no-hex': true,
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla'],
    'declaration-property-value-allowed-list': {
      'font-size': ['inherit', /^(?:var|max|min|clamp|calc)\(/],
    },
    'declaration-property-unit-disallowed-list': {
      '/^(?:margin|padding)(?:-|$)|^(?:gap|row-gap|column-gap)$/': ['px', 'rem', 'em'],
    },

    'defensive-css/require-prefers-reduced-motion': [true, { severity: 'error' }],
    'order/properties-alphabetical-order': true,
    // Only the inline axis flips for right-to-left languages.
    'csstools/use-logical': [
      'always',
      {
        except: [
          'top',
          'bottom',
          /^(?:margin|padding|border)-(?:top|bottom)/,
          'width',
          'height',
          /^(?:min|max)-(?:width|height)$/,
        ],
      },
    ],
    'selector-pseudo-class-no-unknown': [
      true,
      {
        ignorePseudoClasses: ['global'],
      },
    ],
  },
  overrides: [
    {
      // Swipes and previous/next follow the screen, not the text direction.
      files: ['src/lib/ui/media/MediaViewer.svelte'],
      rules: { 'csstools/use-logical': null },
    },
    {
      files: ['src/styles.css'],
      rules: {
        'color-no-hex': null,
        'function-disallowed-list': null,
        'declaration-property-value-allowed-list': null,
        'declaration-property-unit-disallowed-list': null,
        'no-unknown-custom-properties': true,
      },
    },
  ],
};
