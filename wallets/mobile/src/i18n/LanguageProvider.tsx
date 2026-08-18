import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { NativeModules, Platform, StyleSheet, View } from "react-native";
import {
  isLanguageCode,
  languageDateLocales,
  languageNames,
  getBaseTranslationCatalog,
  getTranslation,
  loadTranslationCatalog,
  type ActiveTranslationCatalog,
  type LanguageCode,
  type TranslationKey,
} from "./translations";
import { matchProductLanguage, productLocaleByCode, type ProductTextDirection } from '../../../../config/productLocales';

const LANGUAGE_STORAGE_KEY = "monero_wallet_language";

type TranslationParams = Record<string, string | number>;

type LanguageContextValue = {
  dateLocale: string;
  language: LanguageCode;
  languageLabel: string;
  languageLoading: boolean;
  textDirection: ProductTextDirection;
  setLanguage: (language: LanguageCode) => Promise<void>;
  t: (key: TranslationKey, params?: TranslationParams) => string;
};

const LanguageContext = createContext<LanguageContextValue | undefined>(
  undefined,
);

function getDeviceLanguage(): LanguageCode {
  const settings = NativeModules.SettingsManager?.settings;
  const iosLocale =
    settings?.AppleLocale ?? settings?.AppleLanguages?.[0] ?? undefined;
  const androidLocale = NativeModules.I18nManager?.localeIdentifier;
  const locale =
    Platform.OS === "ios" ? iosLocale : androidLocale ?? iosLocale;

  return matchProductLanguage(locale);
}

function interpolate(value: string, params?: TranslationParams): string {
  if (!params) {
    return value;
  }

  return Object.entries(params).reduce(
    (text, [key, replacement]) =>
      text.replace(new RegExp(`\\{${key}\\}`, "g"), String(replacement)),
    value,
  );
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<LanguageCode>(() =>
    getDeviceLanguage(),
  );
  const [activeCatalog, setActiveCatalog] =
    useState<ActiveTranslationCatalog>();
  const [languageLoading, setLanguageLoading] = useState(
    () => !getBaseTranslationCatalog(getDeviceLanguage()),
  );

  useEffect(() => {
    let mounted = true;

    AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then(value => {
        if (mounted && isLanguageCode(value)) {
          setLanguageState(value);
        }
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const baseCatalog = getBaseTranslationCatalog(language);
    if (baseCatalog) {
      setActiveCatalog(undefined);
      setLanguageLoading(false);
      return undefined;
    }

    let cancelled = false;
    setActiveCatalog(undefined);
    setLanguageLoading(true);
    loadTranslationCatalog(language)
      .then(catalog => {
        if (!cancelled) setActiveCatalog(catalog);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLanguageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [language]);

  const setLanguage = useCallback(async (nextLanguage: LanguageCode) => {
    setLanguageState(nextLanguage);
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => {
      const translated = getTranslation(language, key, activeCatalog);
      return interpolate(translated, params);
    },
    [activeCatalog, language],
  );

  const value = useMemo<LanguageContextValue>(
    () => ({
      dateLocale: languageDateLocales[language],
      language,
      languageLabel: languageNames[language],
      languageLoading,
      textDirection: productLocaleByCode[language].direction,
      setLanguage,
      t,
    }),
    [language, languageLoading, setLanguage, t],
  );

  return (
    <LanguageContext.Provider value={value}>
      <View style={[styles.root, { direction: value.textDirection }]}>{children}</View>
    </LanguageContext.Provider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });

export function useI18n() {
  const context = useContext(LanguageContext);

  if (!context) {
    throw new Error("useI18n must be used inside LanguageProvider");
  }

  return context;
}
