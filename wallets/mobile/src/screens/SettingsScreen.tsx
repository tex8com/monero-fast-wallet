import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Alert,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  TextInput,
  Platform,
} from 'react-native';
import { colors, spacing, radius } from '../theme/colors';
import { Icon } from '../components/Icon';
import {
  languageNames,
  supportedLanguages,
  useI18n,
} from '../i18n';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getActiveNodeConnectionSettings,
  loadActiveNodeConnectionSettings,
} from '../services/NodeConnectionSettings';
import type {
  CommunityFastWalletWorker,
  FastWalletWorkerSelection,
} from '../../../../packages/wallet-shared/src/fastWalletWorkerDirectory';
import { walletService } from '../services/WalletService';
import { useWalletState } from '../services/WalletState';
import {
  type AppProtectionMode,
  useAppSecurity,
} from '../services/AppSecurity';

type ConfigurableAppProtectionMode = Exclude<AppProtectionMode, 'none'>;
import mobileAppVersion from '../../../../config/mobile-app-version.json';
import {
  loadCommunityQueryContributionState,
  setCommunityQueryContributionEnabled,
} from '../services/CommunityQueryContribution';
import {
  loadCachedDerivationPerformance,
  measureDerivationPerformance,
  type DerivationPerformance,
  type DerivationPerformanceProgress,
} from '../services/DerivationPerformance';
import {
  loadCommunityFastWalletWorkers,
  loadFastWalletWorkerSelection,
  selectCommunityFastWalletWorker,
  selectPrivateFastWalletWorker,
  selectRecommendedFastWalletWorker,
} from '../services/FastWalletWorkerSettings';
import { v1ReleaseFeatures } from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import { PROJECT_PAGE_ADDRESSES } from '../../../../packages/wallet-shared/src/projectServices';

export default function SettingsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { dateLocale, language, setLanguage, t } = useI18n();
  const { reconcileLedgerBalance, registeredWallet, session } = useWalletState();
  const {
    mode: savedProtectionMode,
    setMode: setAppProtectionMode,
    autoLockSeconds,
    setAutoLockSeconds,
  } = useAppSecurity();
  const bottomPadding = Math.max(180, insets.bottom + 150);
  const [nodeNetwork, setNodeNetwork] = useState(
    () => getActiveNodeConnectionSettings().network,
  );
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const [isRevealingSeed, setIsRevealingSeed] = useState(false);
  const [isRecheckingLedger, setIsRecheckingLedger] = useState(false);
  const [protectionMode, setProtectionMode] =
    useState<ConfigurableAppProtectionMode>(
      savedProtectionMode === 'none' ? 'biometric' : savedProtectionMode,
    );
  const [appPassword, setAppPassword] = useState('');
  const [confirmAppPassword, setConfirmAppPassword] = useState('');
  const [isSavingAppProtection, setIsSavingAppProtection] = useState(false);
  const [shareCommunitySearches, setShareCommunitySearches] = useState(true);
  const [derivationPerformance, setDerivationPerformance] =
    useState<DerivationPerformance | null>(null);
  const [isMeasuringPerformance, setIsMeasuringPerformance] = useState(false);
  const [performanceProgress, setPerformanceProgress] =
    useState<DerivationPerformanceProgress | null>(null);
  const [workerSelection, setWorkerSelection] =
    useState<FastWalletWorkerSelection>({
      kind: 'recommended',
      network: 'mainnet',
    });
  const [communityWorkers, setCommunityWorkers] = useState<
    CommunityFastWalletWorker[]
  >([]);
  const [workerSettingsBusy, setWorkerSettingsBusy] = useState(false);
  const [workerDirectoryLoading, setWorkerDirectoryLoading] = useState(false);
  const [workerDirectoryError, setWorkerDirectoryError] = useState(false);
  const [showPrivateWorker, setShowPrivateWorker] = useState(false);
  const [privateWorkerDescriptor, setPrivateWorkerDescriptor] = useState('');

  useEffect(() => {
    setProtectionMode(
      savedProtectionMode === 'none' ? 'biometric' : savedProtectionMode,
    );
  }, [savedProtectionMode]);

  useEffect(() => {
    let mounted = true;
    loadCommunityQueryContributionState()
      .then(state => {
        if (mounted) setShareCommunitySearches(state.enabled);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    loadCachedDerivationPerformance()
      .then(result => {
        if (mounted) setDerivationPerformance(result);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    loadFastWalletWorkerSelection(nodeNetwork)
      .then(selection => {
        if (mounted) setWorkerSelection(selection);
      })
      .catch(() => {
        if (mounted) {
          setWorkerSelection({ kind: 'recommended', network: nodeNetwork });
        }
      });
    return () => {
      mounted = false;
    };
  }, [nodeNetwork]);

  useEffect(() => {
    if (
      nodeNetwork !== 'mainnet' ||
      !v1ReleaseFeatures.privateWorkerPairing
    ) {
      setCommunityWorkers([]);
      return;
    }
    let mounted = true;
    setWorkerDirectoryLoading(true);
    setWorkerDirectoryError(false);
    loadCommunityFastWalletWorkers()
      .then(directory => {
        if (mounted) setCommunityWorkers(directory.workers);
      })
      .catch(error => {
        console.warn(
          'MONERO_MOBILE_WORKER_DIRECTORY_FAILED',
          errorMessage(error),
        );
        if (mounted) {
          setCommunityWorkers([]);
          setWorkerDirectoryError(true);
        }
      })
      .finally(() => {
        if (mounted) setWorkerDirectoryLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [nodeNetwork]);

  async function runPerformanceTestbench() {
    if (isMeasuringPerformance) return;
    setIsMeasuringPerformance(true);
    setPerformanceProgress(null);
    try {
      setDerivationPerformance(
        await measureDerivationPerformance(setPerformanceProgress),
      );
    } catch (error) {
      Alert.alert(
        t('settings.scanPerformance'),
        `${t('settings.performanceMeasureFailed')} ${errorMessage(error)}`,
      );
    } finally {
      setIsMeasuringPerformance(false);
      setPerformanceProgress(null);
    }
  }

  async function updateSearchSharing(enabled: boolean) {
    setShareCommunitySearches(enabled);
    try {
      const saved = await setCommunityQueryContributionEnabled(enabled);
      setShareCommunitySearches(saved.enabled);
    } catch {
      setShareCommunitySearches(!enabled);
      Alert.alert(
        t('communityV1.shareSearches'),
        t('communityV1.shareSearchesSaveFailed'),
      );
    }
  }

  useEffect(() => {
    let mounted = true;

    loadActiveNodeConnectionSettings()
      .then(settings => {
        if (!mounted) {
          return;
        }

        setNodeNetwork(settings.network);
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  async function refreshCommunityWorkers() {
    if (workerDirectoryLoading) return;
    setWorkerDirectoryLoading(true);
    setWorkerDirectoryError(false);
    try {
      const directory = await loadCommunityFastWalletWorkers();
      setCommunityWorkers(directory.workers);
    } catch (error) {
      console.warn('MONERO_MOBILE_WORKER_DIRECTORY_FAILED', errorMessage(error));
      setCommunityWorkers([]);
      setWorkerDirectoryError(true);
    } finally {
      setWorkerDirectoryLoading(false);
    }
  }

  async function chooseRecommendedWorker() {
    if (workerSettingsBusy) return;
    setWorkerSettingsBusy(true);
    try {
      setWorkerSelection(
        await selectRecommendedFastWalletWorker(nodeNetwork),
      );
    } catch (error) {
      Alert.alert(t('settings.worker'), errorMessage(error));
    } finally {
      setWorkerSettingsBusy(false);
    }
  }

  async function chooseCommunityWorker(worker: CommunityFastWalletWorker) {
    if (workerSettingsBusy) return;
    setWorkerSettingsBusy(true);
    try {
      setWorkerSelection(
        await selectCommunityFastWalletWorker(nodeNetwork, worker),
      );
    } catch (error) {
      Alert.alert(t('settings.worker'), errorMessage(error));
    } finally {
      setWorkerSettingsBusy(false);
    }
  }

  async function choosePrivateWorker() {
    if (workerSettingsBusy || !privateWorkerDescriptor.trim()) return;
    setWorkerSettingsBusy(true);
    try {
      const selected = await selectPrivateFastWalletWorker(
        nodeNetwork,
        privateWorkerDescriptor,
      );
      setWorkerSelection(selected);
      setPrivateWorkerDescriptor('');
      setShowPrivateWorker(false);
    } catch (error) {
      Alert.alert(t('settings.worker'), errorMessage(error));
    } finally {
      setWorkerSettingsBusy(false);
    }
  }

  async function revealRecoverySeed() {
    if (!session) {
      Alert.alert(
        t('settings.recoverySeedTitle'),
        t('settings.recoverySeedUnavailable'),
      );
      return;
    }
    if (registeredWallet?.kind === 'hardware' || session.hardwareDevice) {
      Alert.alert(
        t('settings.recoverySeedTitle'),
        t('settings.recoverySeedHardware'),
      );
      return;
    }

    setIsRevealingSeed(true);
    try {
      await walletService.presentRecoverySeed(
        session,
        t('settings.recoverySeedWarning'),
      );
    } catch {
      Alert.alert(
        t('settings.recoverySeedTitle'),
        t('settings.recoverySeedError'),
      );
    } finally {
      setIsRevealingSeed(false);
    }
  }

  async function recheckLedgerSpendOutputs() {
    if (!registeredWallet || registeredWallet.kind !== 'hardware' || !session) {
      return;
    }
    setIsRecheckingLedger(true);
    try {
      await reconcileLedgerBalance();
      Alert.alert(
        t('settings.ledgerBalanceVerification'),
        t('settings.ledgerBalanceVerified'),
      );
    } catch (error) {
      console.warn('MONERO_MOBILE_LEDGER_BALANCE_FAILED', errorMessage(error));
      Alert.alert(
        t('settings.ledgerBalanceVerification'),
        t('settings.ledgerBalanceFailed'),
      );
    } finally {
      setIsRecheckingLedger(false);
    }
  }

  async function saveAppProtection() {
    if (appPassword.length < 12) {
      Alert.alert(t('settings.appProtection'), t('settings.passwordMinimum'));
      return;
    }
    if (appPassword !== confirmAppPassword) {
      Alert.alert(
        t('settings.appProtection'),
        t('settings.passwordMismatch'),
      );
      return;
    }

    setIsSavingAppProtection(true);
    try {
      await setAppProtectionMode(
        protectionMode,
        appPassword,
      );
      setAppPassword('');
      setConfirmAppPassword('');
      // Biometric configuration deliberately locks the provider immediately
      // so its single automatic path can present Android's credential sheet.
      // A native success alert here would sit above that sheet, make the first
      // attempt fail, and leave the owner looking at an indefinite spinner.
      if (protectionMode === 'password') {
        Alert.alert(
          t('settings.appProtection'),
          t('settings.appProtectionSaved'),
        );
      }
    } catch (error) {
      console.warn('MONERO_MOBILE_APP_PROTECTION_FAILED', errorMessage(error));
      Alert.alert(
        t('settings.appProtection'),
        t('settings.appProtectionFailed'),
      );
    } finally {
      setIsSavingAppProtection(false);
    }
  }

  const performanceBackendLabel = performanceProgress
    ? performanceProgress.backend === 'cpu'
      ? derivationPerformance?.neonCapable === true || Platform.OS === 'android'
        ? t('settings.cpuNeonBackend')
        : 'CPU'
      : performanceProgress.backend === 'metal'
        ? 'Metal'
        : 'CUDA'
    : '';

  return (
    <View style={s.container}>
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingBottom: bottomPadding }]}
      >
        <View style={s.header}>
          <Text style={s.title}>{t('settings.title')}</Text>
          <Text style={s.version}>
            {t('settings.version', { version: mobileAppVersion.versionName })}
          </Text>
        </View>

        <View style={s.section}>
          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionTitle}>{t('settings.worker')}</Text>
            <Text style={s.nodeStatus}>
              {workerSelection.kind === 'recommended'
                ? t('settings.recommendedWorker')
                : workerSelection.label}
            </Text>
          </View>
          <View style={s.nodePanel}>
            <Text style={s.languageHelp}>{t('settings.workerSubtitle')}</Text>
            <TouchableOpacity
              accessibilityRole="radio"
              accessibilityState={{
                selected: workerSelection.kind === 'recommended',
              }}
              activeOpacity={0.75}
              disabled={workerSettingsBusy}
              onPress={chooseRecommendedWorker}
              style={[
                s.row,
                workerSelection.kind === 'recommended' &&
                  s.nodePresetCardSelected,
              ]}
            >
              <View style={s.rowIconWrap}>
                <Icon name="check" size={20} color={colors.orange} />
              </View>
              <View style={s.rowCopy}>
                <Text style={s.rowLabel}>
                  {t('settings.recommendedWorker')}
                </Text>
                <Text style={s.rowHint}>
                  {t('settings.recommendedWorkerHint')}
                </Text>
              </View>
              {workerSelection.kind === 'recommended' ? (
                <Icon name="check" size={18} color={colors.orange} />
              ) : null}
            </TouchableOpacity>

            {v1ReleaseFeatures.privateWorkerPairing &&
            nodeNetwork === 'mainnet' ? (
              <View style={s.workerGroup}>
                <View style={s.sectionHeaderRow}>
                  <Text style={s.fieldLabel}>
                    {t('settings.communityWorkers')}
                  </Text>
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={workerDirectoryLoading}
                    onPress={refreshCommunityWorkers}
                  >
                    <Text style={s.inlineAction}>
                      {workerDirectoryLoading
                        ? t('settings.workerLoading')
                        : t('action.retry')}
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={s.nodePresetHelp}>
                  {t('settings.communityWorkerHint')}
                </Text>
                {communityWorkers.map(worker => {
                  const selected =
                    workerSelection.kind === 'community' &&
                    workerSelection.workerId === worker.workerId;
                  return (
                    <TouchableOpacity
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      activeOpacity={0.75}
                      disabled={workerSettingsBusy}
                      key={worker.workerId}
                      onPress={() => chooseCommunityWorker(worker)}
                      style={[
                        s.nodePresetCard,
                        selected && s.nodePresetCardSelected,
                      ]}
                    >
                      <View style={s.nodePresetIcon}>
                        <Icon name="users" size={18} color={colors.orange} />
                      </View>
                      <View style={s.nodePresetCopy}>
                        <Text style={s.nodePresetName}>
                          {worker.operatorLabel}
                        </Text>
                        <Text style={s.nodePresetAddress}>
                          {worker.region || t('settings.communityWorker')}
                        </Text>
                      </View>
                      {selected ? (
                        <Icon name="check" size={18} color={colors.orange} />
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
                {workerDirectoryError ? (
                  <Text style={s.warningText}>
                    {t('settings.workerUnavailable')}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {v1ReleaseFeatures.privateWorkerPairing ? (
              <View style={s.workerGroup}>
                <TouchableOpacity
                  accessibilityRole="button"
                  activeOpacity={0.75}
                  onPress={() => setShowPrivateWorker(value => !value)}
                  style={s.row}
                >
                  <View style={s.rowIconWrap}>
                    <Icon name="lock" size={20} color={colors.orange} />
                  </View>
                  <View style={s.rowCopy}>
                    <Text style={s.rowLabel}>
                      {t('settings.privateWorker')}
                    </Text>
                    <Text style={s.rowHint}>
                      {t('settings.privateWorkerHint')}
                    </Text>
                  </View>
                  <Icon
                    name="chevron-right"
                    size={18}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>
                {showPrivateWorker ? (
                  <View style={s.privateWorkerForm}>
                    <TextInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline
                      onChangeText={setPrivateWorkerDescriptor}
                      placeholder={t('settings.privateWorkerPlaceholder')}
                      placeholderTextColor={colors.textMuted}
                      style={[s.input, s.workerDescriptorInput]}
                      value={privateWorkerDescriptor}
                    />
                    <TouchableOpacity
                      accessibilityRole="button"
                      activeOpacity={0.8}
                      disabled={
                        workerSettingsBusy || !privateWorkerDescriptor.trim()
                      }
                      onPress={choosePrivateWorker}
                      style={[
                        s.primaryButton,
                        (workerSettingsBusy ||
                          !privateWorkerDescriptor.trim()) &&
                          s.primaryButtonDisabled,
                      ]}
                    >
                      <Text style={s.primaryButtonText}>
                        {t('settings.useWorker')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{t('settings.projectPage')}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.75}
            onPress={() => navigation.navigate('ProjectPage')}
            style={s.sectionCard}
          >
            <View style={s.row}>
              <View style={s.rowIconWrap}>
                <Icon name="globe" size={20} color={colors.orange} />
              </View>
              <View style={s.rowCopy}>
                <Text style={s.rowLabel}>{t('settings.projectPage')}</Text>
                <Text style={s.rowHint}>{t('settings.projectPageHint')}</Text>
                <View style={s.projectPageAddressList}>
                  {PROJECT_PAGE_ADDRESSES.map(address => (
                    <View key={address.id} style={s.projectPageAddressRow}>
                      <Text
                        style={[
                          s.projectPageTransport,
                          address.transport === 'onion' &&
                            s.projectPageTransportOnion,
                        ]}
                      >
                        {address.transport === 'onion'
                          ? t('projectPage.onion')
                          : t('projectPage.clearnet')}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={s.projectPageAddressPreview}
                      >
                        {address.address}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
              <Icon
                name="chevron-right"
                size={18}
                color={colors.textMuted}
              />
            </View>
          </TouchableOpacity>
        </View>

        {v1ReleaseFeatures.mfwNameRegistration ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>{t('settings.mfwRegistry')}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              activeOpacity={0.75}
              onPress={() => navigation.navigate('MfwNames')}
              style={s.sectionCard}
            >
              <View style={s.row}>
                <View style={s.rowIconWrap}>
                  <Icon name="key" size={20} color={colors.orange} />
                </View>
                <View style={s.rowCopy}>
                  <Text style={s.rowLabel}>{t('mfwNames.title')}</Text>
                  <Text style={s.rowHint}>{t('settings.mfwRegistryHint')}</Text>
                </View>
                <Icon
                  name="chevron-right"
                  size={18}
                  color={colors.textMuted}
                />
              </View>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={s.section}>
          <Text style={s.sectionTitle}>{t('communityV1.privacySettings')}</Text>
          <View style={s.nodePanel}>
            <View style={s.privacySwitchRow}>
              <View style={s.switchText}>
                <Text style={s.switchTitle}>
                  {t('communityV1.shareSearches')}
                </Text>
                <Text style={s.switchValue}>
                  {t('communityV1.shareSearchesSettingsText')}
                </Text>
              </View>
              <Switch
                accessibilityLabel={t('communityV1.shareSearches')}
                value={shareCommunitySearches}
                onValueChange={updateSearchSharing}
                trackColor={{ false: colors.surface, true: colors.orange }}
                thumbColor="#FFF"
              />
            </View>
          </View>
        </View>

        <View style={s.section}>
          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionTitle}>{t('settings.language')}</Text>
            <Text style={s.nodeStatus}>{languageNames[language]}</Text>
          </View>
          <View style={s.nodePanel}>
            <Text style={s.languageHelp}>{t('settings.languageSubtitle')}</Text>
            <TouchableOpacity
              accessibilityLabel={t('settings.languageCurrent', {
                language: languageNames[language],
              })}
              accessibilityRole="button"
              accessibilityState={{ expanded: isLanguageMenuOpen }}
              activeOpacity={0.75}
              onPress={() => setIsLanguageMenuOpen(open => !open)}
              style={s.languageSelectButton}
            >
              <View style={s.languageSelectLabel}>
                <Icon name="language" size={20} color={colors.orange} />
                <Text style={s.languageSelectValue} numberOfLines={1}>
                  {languageNames[language]}
                </Text>
              </View>
              <View
                style={[
                  s.languageChevron,
                  isLanguageMenuOpen && s.languageChevronOpen,
                ]}
              >
                <Icon
                  name="chevron-right"
                  size={18}
                  color={colors.textMuted}
                />
              </View>
            </TouchableOpacity>
            {isLanguageMenuOpen ? (
              <View style={s.languageGrid}>
                {supportedLanguages.map(code => (
                  <TouchableOpacity
                    accessibilityRole="radio"
                    accessibilityState={{ selected: language === code }}
                    key={code}
                    style={[
                      s.languageOption,
                      language === code && s.segmentActive,
                    ]}
                    activeOpacity={0.75}
                    onPress={() => {
                      setIsLanguageMenuOpen(false);
                      setLanguage(code).catch(() => undefined);
                    }}
                  >
                    <Text
                      style={[
                        s.segmentText,
                        language === code && s.segmentTextActive,
                      ]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                    >
                      {languageNames[code]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </View>
        </View>

        <View style={s.section}>
          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionTitle}>{t('settings.scanPerformance')}</Text>
            <Text style={s.nodeStatus}>
              {isMeasuringPerformance
                ? t('settings.performanceMeasuring')
                : derivationPerformance
                  ? t('settings.performanceMeasured')
                  : t('settings.performanceNotMeasured')}
            </Text>
          </View>
          <View style={s.nodePanel}>
            <Text style={s.languageHelp}>
              {t('settings.performanceTestbenchHint')}
            </Text>
            <View style={s.diagnosticList}>
              {(
                [
                  [
                    derivationPerformance?.neonCapable === true ||
                    (!derivationPerformance && Platform.OS === 'android')
                      ? t('settings.cpuNeonBackend')
                      : 'CPU',
                    derivationPerformance?.cpu,
                  ],
                  ['Metal', derivationPerformance?.metal],
                  ['CUDA', derivationPerformance?.cuda],
                ] as const
              ).map(([label, measured]) => (
                <View key={label} style={s.diagnosticRow}>
                  <Text style={s.diagnosticLabel}>{label}</Text>
                  <Text style={s.diagnosticValue}>
                    {isMeasuringPerformance
                      ? t('settings.performanceMeasuringShort')
                      : measured?.verified
                        ? t('settings.derivationsPerSecond', {
                            rate: new Intl.NumberFormat(dateLocale).format(measured.derivationsPerSecond),
                          })
                        : t('settings.performanceUnavailable')}
                  </Text>
                </View>
              ))}
            </View>
            {isMeasuringPerformance && performanceProgress ? (
              <View
                style={s.diagnosticProgress}
                testID="derivation-testbench-progress"
              >
                <Text style={s.diagnosticProgressTitle}>
                  {t('settings.performanceBackendProgress', {
                    backend: performanceBackendLabel,
                    current: performanceProgress.backendIndex,
                    total: performanceProgress.backendCount,
                  })}
                </Text>
                <Text style={s.diagnosticProgressValue}>
                  {t('settings.performanceSeconds', {
                    elapsed: (
                      performanceProgress.backendElapsedMs / 1000
                    ).toFixed(1),
                    duration: performanceProgress.backendDurationMs / 1000,
                  })}
                </Text>
                <View style={s.diagnosticProgressTrack}>
                  <View
                    style={[
                      s.diagnosticProgressFill,
                      { width: `${performanceProgress.backendProgress}%` },
                    ]}
                  />
                </View>
                <Text style={s.performanceOverallProgress}>
                  {t('settings.performanceOverallProgress', {
                    progress: Math.round(performanceProgress.totalProgress),
                  })}
                </Text>
              </View>
            ) : null}
            <TouchableOpacity
              accessibilityRole="button"
              disabled={isMeasuringPerformance}
              onPress={runPerformanceTestbench}
              style={[
                s.secondaryButton,
                isMeasuringPerformance && s.primaryButtonDisabled,
              ]}
              testID="manual-derivation-testbench"
            >
              <Text style={s.secondaryButtonText}>
                {isMeasuringPerformance
                  ? t('settings.performanceTestbenchRunning')
                  : t('settings.runPerformanceTestbench')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{t('settings.appProtection')}</Text>
          <View style={s.nodePanel}>
            <Text style={s.passwordHint}>
              {t('settings.appProtectionHint')}
            </Text>
            {savedProtectionMode === 'none' ? (
              <Text style={s.passwordDestructiveWarning}>
                {t('settings.noProtectionActive')}
              </Text>
            ) : null}
            <View style={s.segmented}>
              {(
                [
                  ['biometric', t('settings.biometrics')],
                  ['password', t('settings.appPassword')],
                ] as const
              ).map(([nextMode, label]) => (
                <TouchableOpacity
                  key={nextMode}
                  accessibilityRole="button"
                  onPress={() => setProtectionMode(nextMode)}
                  style={[
                    s.segment,
                    protectionMode === nextMode && s.segmentActive,
                  ]}
                >
                  <Text
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    style={[
                      s.segmentText,
                      protectionMode === nextMode && s.segmentTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <>
                <Text style={s.passwordDestructiveWarning}>
                  {protectionMode === 'biometric'
                    ? t('security.biometricsFallback')
                    : t('security.passwordRecoveryHelp')}
                </Text>
                <TextInput
                  value={appPassword}
                  onChangeText={setAppPassword}
                  placeholder={t('settings.setAppPassword')}
                  placeholderTextColor={colors.textMuted}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={s.input}
                />
                <TextInput
                  value={confirmAppPassword}
                  onChangeText={setConfirmAppPassword}
                  placeholder={t('settings.confirmAppPassword')}
                  placeholderTextColor={colors.textMuted}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={s.input}
                />
            </>
            <TouchableOpacity
              activeOpacity={0.8}
              disabled={
                isSavingAppProtection ||
                !appPassword || !confirmAppPassword
              }
              onPress={saveAppProtection}
              style={[
                s.secondaryButton,
                (isSavingAppProtection ||
                  !appPassword || !confirmAppPassword) &&
                  s.primaryButtonDisabled,
              ]}
            >
              <Text style={s.secondaryButtonText}>
                {isSavingAppProtection
                  ? t('action.working')
                  : t('settings.saveAppProtection')}
              </Text>
            </TouchableOpacity>
            <Text style={s.passwordHint}>{t('settings.lockAfterInactivity')}</Text>
            <View style={[s.segmented, s.segmentedWrapped]}>
              {[
                [60, t('settings.timeout1Minute')],
                [300, t('settings.timeout5Minutes')],
                [900, t('settings.timeout15Minutes')],
                [1800, t('settings.timeout30Minutes')],
                [3600, t('settings.timeout1Hour')],
                [0, t('settings.timeoutNever')],
              ].map(([seconds, label]) => (
                <TouchableOpacity
                  accessibilityRole="button"
                  key={seconds}
                  onPress={() => {
                    setAutoLockSeconds(Number(seconds)).catch(error => {
                      console.warn(
                        'MONERO_MOBILE_AUTO_LOCK_FAILED',
                        errorMessage(error),
                      );
                      Alert.alert(
                        t('settings.appProtection'),
                        t('settings.appProtectionFailed'),
                      );
                    });
                  }}
                  style={[
                    s.segment,
                    autoLockSeconds === seconds && s.segmentActive,
                  ]}
                >
                  <Text style={[
                    s.segmentText,
                    autoLockSeconds === seconds && s.segmentTextActive,
                  ]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{t('settings.wallet')}</Text>
          <View style={s.sectionCard}>
            <TouchableOpacity
              accessibilityRole="button"
              activeOpacity={0.7}
              disabled={!session || isRevealingSeed}
              onPress={() => {
                revealRecoverySeed();
              }}
              style={[s.row, (!session || isRevealingSeed) && s.rowDisabled]}
            >
              <View style={s.rowIconWrap}>
                <Icon name="key" size={20} color={colors.orange} />
              </View>
              <View style={s.rowCopy}>
                <Text style={s.rowLabel}>{t('settings.showBackupSeed')}</Text>
                <Text style={s.rowHint}>
                  {t('settings.recoverySeedDescription')}
                </Text>
              </View>
              <Icon name="chevron-right" size={18} color={colors.textMuted} />
            </TouchableOpacity>
            {registeredWallet?.kind === 'hardware' &&
            registeredWallet.role !== 'fast' ? (
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.7}
                disabled={!session || isRecheckingLedger}
                onPress={() => {
                  recheckLedgerSpendOutputs();
                }}
                style={[
                  s.row,
                  (!session || isRecheckingLedger) && s.rowDisabled,
                ]}
              >
                <View style={s.rowIconWrap}>
                  <Icon name="key" size={20} color={colors.orange} />
                </View>
                <View style={s.rowCopy}>
                  <Text style={s.rowLabel}>
                    {isRecheckingLedger
                      ? t('settings.ledgerBalanceVerifying')
                      : t('settings.ledgerBalanceVerification')}
                  </Text>
                  <Text style={s.rowHint}>
                    {t('settings.ledgerBalanceVerificationHint')}
                  </Text>
                </View>
                <Icon name="chevron-right" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        <Text
          style={s.bottomVersion}
        >{`Monero Fast Wallet · v${mobileAppVersion.versionName}`}</Text>
        <View style={s.bottomSpacer} />
      </ScrollView>
    </View>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 12 },
  header: { alignItems: 'flex-start', marginBottom: 28, gap: 5 },
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '800',
  },
  version: { color: colors.textMuted, fontSize: 13 },
  section: { marginBottom: 24 },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
    paddingLeft: 4,
  },
  sectionCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  nodeStatus: {
    color: colors.success,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
    paddingRight: 4,
  },
  nodeStatusDirty: { color: colors.warning },
  nodePanel: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 12,
  },
  nodePresetSection: { gap: 8 },
  nodePresetList: { gap: 8 },
  nodeRouteLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '800',
    marginTop: 6,
    textTransform: 'uppercase',
  },
  nodePresetCard: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 70,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  nodePresetCardSelected: {
    backgroundColor: colors.orangeMuted,
    borderColor: colors.orange,
  },
  nodePresetIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
  },
  nodePresetCopy: { flex: 1 },
  nodePresetHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  nodePresetName: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  nodePresetTransport: {
    backgroundColor: `${colors.success}18`,
    borderRadius: radius.full,
    color: colors.success,
    fontSize: 9,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  nodePresetTransportOnion: {
    backgroundColor: `${colors.orange}18`,
    color: colors.orange,
  },
  nodePresetAddress: {
    color: colors.textMuted,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
    marginTop: 5,
  },
  nodePresetHelp: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  workerGroup: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: 8,
    paddingTop: 12,
  },
  inlineAction: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  warningText: {
    color: colors.warning,
    fontSize: 12,
    lineHeight: 17,
  },
  privateWorkerForm: { gap: 10 },
  workerDescriptorInput: {
    minHeight: 92,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  rowDisabled: { opacity: 0.5 },
  rowCopy: { flex: 1, gap: 3 },
  rowHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  projectPageAddressList: { gap: 5, marginTop: 5 },
  projectPageAddressRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  projectPageTransport: {
    color: colors.success,
    fontSize: 8,
    fontWeight: '900',
    textTransform: 'uppercase',
    width: 42,
  },
  projectPageTransportOnion: { color: colors.orangeLight },
  projectPageAddressPreview: {
    color: colors.orangeLight,
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 10,
  },
  passwordPanel: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
    gap: 10,
  },
  passwordTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  passwordHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  passwordDestructiveWarning: {
    backgroundColor: 'rgba(255, 72, 96, 0.08)',
    borderColor: 'rgba(255, 72, 96, 0.34)',
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.error,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
    padding: 12,
  },
  languageHelp: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  languageSelectButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    paddingHorizontal: 14,
  },
  languageSelectLabel: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  languageSelectValue: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  languageChevron: { transform: [{ rotate: '90deg' }] },
  languageChevronOpen: { transform: [{ rotate: '-90deg' }] },
  languageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 4,
  },
  segmentedWrapped: { flexWrap: 'wrap' },
  languageOption: {
    width: '48%',
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    paddingHorizontal: 8,
  },
  nodeHintBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(242,104,34,0.18)',
    backgroundColor: 'rgba(242,104,34,0.08)',
    padding: spacing.md,
  },
  nodeHintText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.bgInput,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    paddingHorizontal: 6,
  },
  segmentActive: { backgroundColor: colors.orange },
  segmentText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  segmentTextActive: { color: '#FFF' },
  inputGroup: { gap: 6 },
  fieldLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    paddingLeft: 2,
  },
  input: {
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    color: colors.textPrimary,
    fontSize: 14,
    paddingHorizontal: 14,
  },
  inputDisabled: { color: colors.textMuted, opacity: 0.72 },
  switchRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radius.md,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
  },
  privacySwitchRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  switchText: { flex: 1, paddingRight: 12 },
  switchTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
  switchValue: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  advancedFields: { gap: 12 },
  secretRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 2,
  },
  secretText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  secretButton: {
    minHeight: 34,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgInput,
  },
  secretButtonText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '800',
  },
  nodeActions: { flexDirection: 'row', gap: 10, marginTop: 2 },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgInput,
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  primaryButton: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.md,
    backgroundColor: colors.orange,
  },
  primaryButtonDisabled: { opacity: 0.45 },
  primaryButtonText: { color: '#FFF', fontSize: 14, fontWeight: '800' },
  identityList: { gap: 8 },
  identityRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: radius.md,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
  },
  identityIcon: { width: 28, alignItems: 'center', justifyContent: 'center' },
  identityText: { flex: 1, minWidth: 0 },
  identityLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  identityAddress: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  identityStatus: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  diagnosticList: { gap: 8 },
  diagnosticRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: radius.md,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
  },
  diagnosticLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  diagnosticValue: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'right',
  },
  diagnosticProgress: {
    gap: 8,
    borderRadius: radius.md,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  diagnosticProgressTitle: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  diagnosticProgressValue: {
    position: 'absolute',
    right: 12,
    top: 12,
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  diagnosticProgressTrack: {
    height: 5,
    overflow: 'hidden',
    borderRadius: radius.full,
    backgroundColor: colors.surface,
  },
  diagnosticProgressFill: {
    height: '100%',
    borderRadius: radius.full,
    backgroundColor: colors.orange,
  },
  performanceOverallProgress: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'right',
  },
  diagnosticSummary: {
    flexDirection: 'row',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    paddingVertical: 12,
  },
  diagnosticCount: { flex: 1, alignItems: 'center', gap: 3 },
  diagnosticCountValue: { fontSize: 18, fontWeight: '900' },
  diagnosticCountLabel: { color: colors.textSecondary, fontSize: 10 },
  diagnosticTest: {
    gap: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    padding: 12,
  },
  diagnosticTestHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  diagnosticTestHeading: { flex: 1, gap: 2 },
  diagnosticCategory: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  diagnosticTestTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  diagnosticBadge: {
    fontSize: 10,
    fontWeight: '900',
  },
  diagnosticSummaryText: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  diagnosticMetrics: { gap: 4 },
  diagnosticMetric: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 6,
  },
  diagnosticMetricLabel: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  diagnosticMetricValue: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
  },
  diagnosticDuration: {
    color: colors.textSecondary,
    fontSize: 10,
    textAlign: 'right',
  },
  diagnosticRunDuration: {
    color: colors.textSecondary,
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: spacing.md,
    gap: 12,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowIconWrap: { width: 28, alignItems: 'center', justifyContent: 'center' },
  rowLabel: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '500',
  },
  logoutBtn: {
    marginTop: 8,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: 'rgba(255,68,102,0.1)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,68,102,0.2)',
  },
  logoutBtnDisabled: { opacity: 0.45 },
  logoutText: { color: colors.error, fontSize: 16, fontWeight: '600' },
  bottomVersion: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.25,
    opacity: 0.5,
    textAlign: 'center',
  },
  bottomSpacer: { height: 24 },
});
