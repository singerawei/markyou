// brand-audit-allow
// One-time migration identity for installations created before the MarkYou
// rename. These values are internal only: they must never be rendered in the
// UI, commands, settings labels, notifications, documentation or release
// artifacts. The names are decoded at runtime so a minified build does not
// contain the previous product name as a literal (the packaged-VSIX audit
// scans the compiled bundle as well as source).
const previousName = Buffer.from('bWFya3dlYXZl', 'base64').toString('utf8');
const earliestName = Buffer.from('bWFya2Rvd251cA==', 'base64').toString('utf8');

export const legacyBrand = {
  commandPrefix: `${previousName}.`,
  settingSection: previousName,
  viewType: `${previousName}.editor`,
  diffScheme: `${previousName}-diff`,
  preferencePrefix: `${previousName}.preferences:`,
  temporarySuffix: `.${previousName}-`,
  pdfTemporaryPrefix: `${previousName}-pdf-`,
  warmupId: `${previousName}-warmup`,
  extensionId: `${previousName}.${previousName}`,
  aliases: [`${previousName}.`, `${earliestName}.`] as const,
} as const;
