const MFW_SUFFIX = '.mfw';
const MIN_AUTOCOMPLETE_LABEL_LENGTH = 3;

export function mfwNameAutocompletePrefix(input: string): string | undefined {
  let query = input.trim().toLowerCase();
  if (!query || query.length > 67 || /\s/.test(query)) return undefined;

  const dot = query.indexOf('.');
  if (dot !== -1) {
    if (query.indexOf('.', dot + 1) !== -1) return undefined;
    const suffixPart = query.slice(dot);
    if (!MFW_SUFFIX.startsWith(suffixPart)) return undefined;
    query = query.slice(0, dot);
  }

  if (
    query.length < MIN_AUTOCOMPLETE_LABEL_LENGTH ||
    query.length > 63 ||
    query.startsWith('-') ||
    query.endsWith('-') ||
    !/^[a-z0-9-]+$/.test(query)
  ) {
    return undefined;
  }
  return query;
}

export function mfwNameAutocompleteSuggestions(
  input: string,
  resolverNames: readonly string[],
  maximum = 5,
): string[] {
  const prefix = mfwNameAutocompletePrefix(input);
  if (!prefix || !Number.isSafeInteger(maximum) || maximum < 1) return [];
  return [...new Set(resolverNames.map(normalizeKnownName))]
    .filter((name): name is string => Boolean(name))
    .filter((name) => name.startsWith(prefix))
    .slice(0, maximum);
}

export function isMfwNameCandidate(value: string): boolean {
  return value.trim().toLowerCase().endsWith(MFW_SUFFIX);
}

function normalizeKnownName(value: string): string | undefined {
  const name = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mfw$/.test(name)
    ? name
    : undefined;
}
