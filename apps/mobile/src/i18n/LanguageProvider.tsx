import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { NativeModules, Platform } from "react-native";
import {
  isLanguageCode,
  languageDateLocales,
  languageNames,
  type LanguageCode,
  translations,
  type TranslationKey,
} from "./translations";

const LANGUAGE_STORAGE_KEY = "monero_wallet_language";

type TranslationParams = Record<string, string | number>;

type LanguageContextValue = {
  dateLocale: string;
  language: LanguageCode;
  languageLabel: string;
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

  if (typeof locale === "string" && locale.toLowerCase().startsWith("de")) {
    return "de";
  }

  return "en";
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

  const setLanguage = useCallback(async (nextLanguage: LanguageCode) => {
    setLanguageState(nextLanguage);
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => {
      const translated = translations[language][key] ?? translations.en[key];
      return interpolate(translated, params);
    },
    [language],
  );

  const value = useMemo<LanguageContextValue>(
    () => ({
      dateLocale: languageDateLocales[language],
      language,
      languageLabel: languageNames[language],
      setLanguage,
      t,
    }),
    [language, setLanguage, t],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(LanguageContext);

  if (!context) {
    throw new Error("useI18n must be used inside LanguageProvider");
  }

  return context;
}
