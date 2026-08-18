import { normalizeMfwName } from './PrivateRecipientResolution';

const MFW_SUFFIX = '.mfw';
const MIN_AUTOCOMPLETE_LABEL_LENGTH = 3;

/**
 * Normalizes the label prefix sent to the public Registry resolver. An exact
 * `.mfw` name is resolved separately; this helper never invents a completion.
 */
export function mfwNameAutocompletePrefix(input: string): string | undefined {
  const query = input.trim().toLowerCase();
  return autocompleteLabel(query);
}

export function mfwNameAutocompleteSuggestions(
  input: string,
  resolverNames: readonly string[],
  maximum = 5,
): string[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    return [];
  }
  const label = mfwNameAutocompletePrefix(input);
  if (!label) {
    return [];
  }
  return [...new Set(resolverNames.map(normalizeKnownName))]
    .filter((name): name is string => Boolean(name))
    .filter(name => name.startsWith(label))
    .slice(0, maximum);
}

function autocompleteLabel(query: string): string | undefined {
  if (!query || query.length > 67 || /\s/.test(query)) {
    return undefined;
  }

  const dot = query.indexOf('.');
  if (dot !== -1) {
    if (query.indexOf('.', dot + 1) !== -1) {
      return undefined;
    }
    const suffixPart = query.slice(dot);
    if (!MFW_SUFFIX.startsWith(suffixPart)) {
      return undefined;
    }
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

function normalizeKnownName(value: string): string | undefined {
  try {
    return normalizeMfwName(value.trim());
  } catch {
    return undefined;
  }
}
