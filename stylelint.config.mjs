export default {
  defaultSeverity: 'error',
  extends: ['stylelint-config-standard', 'stylelint-config-html/svelte'],
  ignoreFiles: ['.svelte-kit/**', 'dist/**', 'node_modules/**', 'src/generated/**'],
  plugins: ['stylelint-order', 'stylelint-plugin-defensive-css'],
  rules: {
    'defensive-css/require-prefers-reduced-motion': [true, { severity: 'error' }],
    'order/properties-alphabetical-order': true,
    'selector-pseudo-class-no-unknown': [
      true,
      {
        ignorePseudoClasses: ['global'],
      },
    ],
  },
};
