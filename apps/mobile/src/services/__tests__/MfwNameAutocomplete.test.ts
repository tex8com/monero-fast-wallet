import {
  mfwNameAutocompletePrefix,
  mfwNameAutocompleteSuggestions,
} from '../MfwNameAutocomplete';

describe('MFW name recipient autocomplete', () => {
  it('requests a normalized Registry prefix only after three characters', () => {
    expect(mfwNameAutocompletePrefix('te')).toBeUndefined();
    expect(mfwNameAutocompletePrefix('Tex')).toBe('tex');
    expect(mfwNameAutocompletePrefix('tex8.m')).toBe('tex8');
    expect(mfwNameAutocompletePrefix('tex8.mfw')).toBe('tex8');
  });

  it('shows only matching names returned by the Registry resolver', () => {
    expect(
      mfwNameAutocompleteSuggestions('tes', [
        'test.mfw',
        'tex8.mfw',
        'alice.mfw',
      ]),
    ).toEqual(['test.mfw']);
    expect(mfwNameAutocompleteSuggestions('tex', [])).toEqual([]);
  });

  it('does not query or suggest for addresses or malformed labels', () => {
    expect(mfwNameAutocompletePrefix(`4${'1'.repeat(94)}`)).toBeUndefined();
    expect(mfwNameAutocompletePrefix('bad name')).toBeUndefined();
    expect(mfwNameAutocompletePrefix('-bad')).toBeUndefined();
    expect(mfwNameAutocompletePrefix('bad.example')).toBeUndefined();
  });
});
