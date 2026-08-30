export default {
  defaultSeverity: 'error',
  extends: ['stylelint-config-standard', 'stylelint-config-html/svelte'],
  ignoreFiles: ['.svelte-kit/**', 'dist/**', 'node_modules/**', 'src/generated/**'],
  plugins: ['stylelint-order', 'stylelint-plugin-defensive-css'],
  rules: {
    // Conciseness and duplication
    'declaration-block-no-duplicate-properties': true,
    'declaration-block-no-duplicate-custom-properties': true,
    'declaration-block-no-redundant-longhand-properties': true,
    'shorthand-property-no-redundant-values': true,
    'no-duplicate-selectors': true,
    'block-no-redundant-nested-style-rules': true,

    // Keep CSS structurally simple
    'max-nesting-depth': 2,
    'selector-max-combinators': 3,
    'declaration-no-important': true,

    // Keep specificity predictable and declarations unambiguous
    'no-descending-specificity': true,
    'declaration-block-no-shorthand-property-overrides': true,
    'no-duplicate-at-import-rules': true,
    'keyframe-block-no-duplicate-selectors': true,
    'declaration-property-value-disallowed-list': {
      '/^border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$/': [
        '/\\b\\d*\\.?\\d+(?:px|rem|em)\\b/',
      ],
      'font-size': ['/\\b\\d*\\.?\\d+(?:px|rem|em|pt)\\b/'],
      '/^(?:padding|margin)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?$/': [
        '/-?(?:\\d*\\.)?\\d+(?:px|rem|em)\\b/',
      ],
      '/^(?:gap|row-gap|column-gap)$/': ['/-?(?:\\d*\\.)?\\d+(?:px|rem|em)\\b/'],
    },

    'defensive-css/require-prefers-reduced-motion': [true, { severity: 'error' }],
    'order/properties-alphabetical-order': true,
    'selector-pseudo-class-no-unknown': [
      true,
      {
        ignorePseudoClasses: ['global'],
      },
    ],
  },
  overrides: [
    {
      files: ['src/styles.css'],
      rules: {
        'declaration-property-value-disallowed-list': null,
      },
    },
  ],
};
