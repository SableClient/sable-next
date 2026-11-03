import axe from 'axe-core';

// Run in the browser project: contrast and visibility checks need real layout.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// A component rendered alone has no page around it.
const STANDALONE_RULES_OFF = ['region', 'page-has-heading-one'];

export interface A11yOptions {
  /** Rule id mapped to why it is a false positive for this render. */
  disableRules?: Record<string, string>;
}

export const ICONS_HIDDEN_BY_LAYOUT = {
  'svg-img-alt':
    'icons are aria-hidden by the IconContext in +layout.svelte, which an isolated render lacks',
};

export async function a11yViolations(root: Element, options: A11yOptions = {}): Promise<string[]> {
  const off = [...STANDALONE_RULES_OFF, ...Object.keys(options.disableRules ?? {})];
  const rules = Object.fromEntries(off.map((id) => [id, { enabled: false }]));
  const result = await axe.run(root, { runOnly: { type: 'tag', values: TAGS }, rules });
  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.helpUrl})\n` +
      violation.nodes
        .map((node) => `  ${node.target.join(' ')}  ${node.html.slice(0, 160)}`)
        .join('\n')
  );
}

export async function expectNoA11yViolations(root: Element, options?: A11yOptions): Promise<void> {
  const violations = await a11yViolations(root, options);
  if (violations.length) {
    throw new Error(`Accessibility violations:\n${violations.join('\n')}`);
  }
}
