export function formatMessage(
  template: string,
  values: Readonly<Record<string, string | number>>
): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key])
      : placeholder
  );
}
