import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Alert,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  TextInput,
} from 'react-native';
import { colors, spacing, radius } from '../theme/colors';
import MoneroLogo from '../components/MoneroLogo';
import { Icon } from '../components/Icon';
import {
  languageNames,
  supportedLanguages,
  type TranslationKey,
  useI18n,
} from '../i18n';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MoneroNetwork } from '../services/NativeMoneroWallet';
import {
  applyNodeModeDefaults,
  applyNodeNetworkDefaults,
  createDefaultNodeConnectionSettings,
  deriveOptimizedGrpcEndpointFromDaemonAddress,
  getActiveNodeConnectionSettings,
  loadActiveNodeConnectionSettings,
  nodeConnectionDraftToSettings,
  nodeConnectionSettingsToDraft,
  saveActiveNodeConnectionSettings,
} from '../services/NodeConnectionSettings';
import type {
  NodeConnectionDraft,
  NodeConnectionMode,
} from '../services/NodeConnectionSettings';
import {
  runWalletDiagnosticTestbench,
  type DiagnosticProgress,
} from '../services/WalletDiagnosticTestbench';
import type { DiagnosticTestbenchReport } from '../../../../packages/wallet-shared/src/diagnosticTestbench';
import { walletService } from '../services/WalletService';
import { useWalletState } from '../services/WalletState';
import {
  type AppProtectionMode,
  useAppSecurity,
} from '../services/AppSecurity';
import mobileAppVersion from '../../../../config/mobile-app-version.json';
import {
  loadCommunityQueryContributionState,
  setCommunityQueryContributionEnabled,
} from '../services/CommunityQueryContribution';
import {
  loadDerivationPerformance,
  type DerivationPerformance,
} from '../services/DerivationPerformance';
import { FastWalletPushService } from '../services/FastWalletPushService';

const NODE_MODES: { value: NodeConnectionMode; labelKey: TranslationKey }[] = [
  { value: 'optimized-grpc', labelKey: 'settings.nodeModeTex8' },
  { value: 'original-rpc', labelKey: 'settings.nodeModeOriginal' },
];

const NETWORKS: { value: MoneroNetwork; label: string }[] = [
  { value: 'mainnet', label: 'Mainnet' },
  { value: 'testnet', label: 'Testnet' },
  { value: 'stagenet', label: 'Stagenet' },
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { language, setLanguage, t } = useI18n();
  const { reconcileLedgerBalance, registeredWallet, session } = useWalletState();
  const {
    mode: savedProtectionMode,
    setMode: setAppProtectionMode,
    autoLockSeconds,
    setAutoLockSeconds,
  } = useAppSecurity();
  const bottomPadding = Math.max(180, insets.bottom + 150);
  const [draft, setDraft] = useState<NodeConnectionDraft>(() =>
    nodeConnectionSettingsToDraft(getActiveNodeConnectionSettings()),
  );
  const [savedSettings, setSavedSettings] = useState(() =>
    getActiveNodeConnectionSettings(),
  );
  const [isLoadingNodeSettings, setIsLoadingNodeSettings] = useState(true);
  const [isSavingNodeSettings, setIsSavingNodeSettings] = useState(false);
  const [nodeStatusText, setNodeStatusText] = useState('Loading');
  const [diagnosticsStatusText, setDiagnosticsStatusText] = useState('Ready');
  const [diagnosticReport, setDiagnosticReport] =
    useState<DiagnosticTestbenchReport | null>(null);
  const [diagnosticProgress, setDiagnosticProgress] =
    useState<DiagnosticProgress | null>(null);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);
  const [isSendingTestPush, setIsSendingTestPush] = useState(false);
  const [isRevealingSeed, setIsRevealingSeed] = useState(false);
  const [isRecheckingLedger, setIsRecheckingLedger] = useState(false);
  const [protectionMode, setProtectionMode] =
    useState<AppProtectionMode>(savedProtectionMode);
  const [appPassword, setAppPassword] = useState('');
  const [confirmAppPassword, setConfirmAppPassword] = useState('');
  const [isSavingAppProtection, setIsSavingAppProtection] = useState(false);
  const [shareCommunitySearches, setShareCommunitySearches] = useState(true);
  const [derivationPerformance, setDerivationPerformance] =
    useState<DerivationPerformance | null>(null);
  const [isMeasuringPerformance, setIsMeasuringPerformance] = useState(true);

  useEffect(() => {
    setProtectionMode(savedProtectionMode);
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
    loadDerivationPerformance()
      .then(result => {
        if (mounted) setDerivationPerformance(result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted) setIsMeasuringPerformance(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

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

        const visibleSettings =
          settings.mode === 'custom'
            ? createDefaultNodeConnectionSettings(
                settings.network,
                'optimized-grpc',
              )
            : settings;

        setSavedSettings(visibleSettings);
        setDraft(nodeConnectionSettingsToDraft(visibleSettings));
        setNodeStatusText('Saved');
      })
      .catch(() => {
        if (mounted) {
          setNodeStatusText('Default');
        }
      })
      .finally(() => {
        if (mounted) {
          setIsLoadingNodeSettings(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const resolvedSettings = useMemo(
    () => nodeConnectionDraftToSettings(draft),
    [draft],
  );

  const canSave =
    resolvedSettings.daemon.address.length > 0 &&
    (draft.mode !== 'optimized-grpc' ||
      resolvedSettings.grpcEndpoint.length > 0);
  const hasChanges =
    JSON.stringify(resolvedSettings) !== JSON.stringify(savedSettings);
  const isOriginalRpc = draft.mode === 'original-rpc';
  const nodeStatus =
    hasChanges && !isLoadingNodeSettings ? 'Unsaved' : nodeStatusText;
  const displayedNodeStatus = translateStatusText(nodeStatus, t);
  const displayedDiagnosticsStatus = translateStatusText(
    diagnosticsStatusText,
    t,
  );

  function updateDraft<K extends keyof NodeConnectionDraft>(
    key: K,
    value: NodeConnectionDraft[K],
  ) {
    setDraft(current => ({
      ...current,
      [key]: value,
    }));
  }

  function updateFastWalletServerAddress(value: string) {
    setDraft(current => {
      const currentDerivedGrpc = deriveOptimizedGrpcEndpointFromDaemonAddress(
        current.daemonAddress,
        current.network,
      );
      const shouldFollowDaemon =
        current.grpcEndpoint.trim().length === 0 ||
        current.grpcEndpoint.trim() === currentDerivedGrpc;

      return {
        ...current,
        daemonAddress: value,
        grpcEndpoint: shouldFollowDaemon
          ? deriveOptimizedGrpcEndpointFromDaemonAddress(value, current.network)
          : current.grpcEndpoint,
      };
    });
  }

  function setMode(mode: NodeConnectionMode) {
    setDraft(current => applyNodeModeDefaults(current, mode));
  }

  function setNetwork(network: MoneroNetwork) {
    setDraft(current => applyNodeNetworkDefaults(current, network));
  }

  function resetNodeDefaults() {
    setDraft(
      nodeConnectionSettingsToDraft(
        createDefaultNodeConnectionSettings(draft.network, draft.mode),
      ),
    );
  }

  async function saveNodeSettings() {
    if (!canSave || isSavingNodeSettings) {
      return;
    }

    setIsSavingNodeSettings(true);
    setNodeStatusText('Saving');

    try {
      const saved = await saveActiveNodeConnectionSettings(resolvedSettings);
      const applied = await walletService.applyNodeConnectionToActive(saved);
      await walletService.refreshFastReceiveRegistrationStatusesForSettings(
        saved,
      );

      setSavedSettings(saved);
      setDraft(nodeConnectionSettingsToDraft(saved));
      setNodeStatusText(applied ? 'Applied' : 'Saved');
    } catch {
      setNodeStatusText('Error');
    } finally {
      setIsSavingNodeSettings(false);
    }
  }

  async function runSettingsDiagnostics() {
    if (isRunningDiagnostics) {
      return;
    }

    setIsRunningDiagnostics(true);
    setDiagnosticsStatusText('Running');

    try {
      const diagnostics = await runWalletDiagnosticTestbench(progress => {
        setDiagnosticProgress(progress);
      });
      setDiagnosticReport(diagnostics);
      setDiagnosticsStatusText(
        diagnostics.failed > 0
          ? 'Error'
          : diagnostics.warnings > 0
            ? 'Warnings'
            : 'Ready',
      );
    } catch (error) {
      setDiagnosticReport(null);
      setDiagnosticsStatusText('Error');
      Alert.alert(t('settings.diagnostics'), errorMessage(error));
    } finally {
      setDiagnosticProgress(null);
      setIsRunningDiagnostics(false);
    }
  }

  async function sendTestPush() {
    if (isSendingTestPush) return;
    setIsSendingTestPush(true);
    try {
      const registration = await FastWalletPushService.sendTestNotification();
      Alert.alert(
        'Test notification sent',
        `FCM token created (${registration.providerTokenLength} characters), App Check and Gateway registration accepted. Firebase accepted a generic test notification for this phone. It contains no wallet or transaction details.`,
      );
    } catch (error) {
      Alert.alert('Test notification', errorMessage(error));
    } finally {
      setIsSendingTestPush(false);
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
      Alert.alert(
        t('settings.ledgerBalanceVerification'),
        errorMessage(error),
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
      Alert.alert(t('settings.appProtection'), errorMessage(error));
    } finally {
      setIsSavingAppProtection(false);
    }
  }

  return (
    <View style={s.container}>
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingBottom: bottomPadding }]}
      >
        <View style={s.header}>
          <MoneroLogo size={44} />
          <Text style={s.title}>{t('settings.title')}</Text>
          <Text style={s.version}>Version {mobileAppVersion.versionName}</Text>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{t('communityV1.privacySettings')}</Text>
          <View style={s.nodePanel}>
            <View style={s.switchRow}>
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
            <View style={s.segmented}>
              {supportedLanguages.map(code => (
                <TouchableOpacity
                  key={code}
                  style={[s.segment, language === code && s.segmentActive]}
                  activeOpacity={0.75}
                  onPress={() => {
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
                  : t('settings.performanceUnavailable')}
            </Text>
          </View>
          <View style={s.nodePanel}>
            <Text style={s.languageHelp}>
              {t('settings.scanPerformanceHint')}
            </Text>
            <View style={s.diagnosticList}>
              {(
                [
                  ['CPU', derivationPerformance?.cpu],
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
                            rate: new Intl.NumberFormat(
                              language === 'de' ? 'de-DE' : 'en-US',
                            ).format(measured.derivationsPerSecond),
                          })
                        : t('settings.performanceUnavailable')}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{t('settings.appProtection')}</Text>
          <View style={s.nodePanel}>
            <Text style={s.passwordHint}>
              {t('settings.appProtectionHint')}
            </Text>
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
            <Text style={s.passwordHint}>Lock after inactivity</Text>
            <View style={[s.segmented, { flexWrap: 'wrap' }]}>
              {[
                [60, '1 min'],
                [300, '5 min'],
                [900, '15 min'],
                [1800, '30 min'],
                [3600, '1 hour'],
                [0, 'Never'],
              ].map(([seconds, label]) => (
                <TouchableOpacity
                  accessibilityRole="button"
                  key={seconds}
                  onPress={() => {
                    setAutoLockSeconds(Number(seconds)).catch(error =>
                      Alert.alert(t('settings.appProtection'), errorMessage(error)),
                    );
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
              onPress={() => void revealRecoverySeed()}
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
                onPress={() => void recheckLedgerSpendOutputs()}
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

        <View style={s.section}>
          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionTitle}>{t('settings.node')}</Text>
            <Text style={[s.nodeStatus, hasChanges && s.nodeStatusDirty]}>
              {displayedNodeStatus}
            </Text>
          </View>
          <View style={s.nodePanel}>
            <Text style={s.fieldLabel}>{t('settings.mode')}</Text>
            <View style={s.segmented}>
              {NODE_MODES.map(mode => (
                <TouchableOpacity
                  key={mode.value}
                  style={[
                    s.segment,
                    draft.mode === mode.value && s.segmentActive,
                  ]}
                  activeOpacity={0.75}
                  onPress={() => setMode(mode.value)}
                >
                  <Text
                    style={[
                      s.segmentText,
                      draft.mode === mode.value && s.segmentTextActive,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {t(mode.labelKey)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={s.fieldLabel}>{t('settings.network')}</Text>
            <View style={s.segmented}>
              {NETWORKS.map(network => (
                <TouchableOpacity
                  key={network.value}
                  style={[
                    s.segment,
                    draft.network === network.value && s.segmentActive,
                  ]}
                  activeOpacity={0.75}
                  onPress={() => setNetwork(network.value)}
                >
                  <Text
                    style={[
                      s.segmentText,
                      draft.network === network.value && s.segmentTextActive,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {network.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={s.nodeHintBox}>
              <Icon
                name="info"
                size={16}
                color={isOriginalRpc ? colors.warning : colors.orange}
              />
              <Text style={s.nodeHintText}>
                {isOriginalRpc
                  ? t('settings.originalNodeHelp')
                  : t('settings.tex8NodeHelp')}
              </Text>
            </View>

            {isOriginalRpc ? (
              <NodeInput
                label={t('settings.originalNodeAddress')}
                value={draft.daemonAddress}
                onChangeText={value => updateDraft('daemonAddress', value)}
                placeholder="host:port"
              />
            ) : (
              <>
                <NodeInput
                  label={t('settings.fastWalletServerAddress')}
                  value={draft.daemonAddress}
                  onChangeText={updateFastWalletServerAddress}
                  placeholder="xmr.tex8.com:18089"
                />
                <NodeInput
                  label={t('settings.grpcEndpoint')}
                  value={draft.grpcEndpoint}
                  onChangeText={value => updateDraft('grpcEndpoint', value)}
                  placeholder="xmr.tex8.com:18091"
                />
              </>
            )}

            <View style={s.switchRow}>
              <View style={s.switchText}>
                <Text style={s.switchTitle}>{t('settings.trustedDaemon')}</Text>
                <Text style={s.switchValue}>
                  {draft.trusted ? t('common.on') : t('common.off')}
                </Text>
              </View>
              <Switch
                value={draft.trusted}
                onValueChange={value => updateDraft('trusted', value)}
                trackColor={{ false: colors.surface, true: colors.orange }}
                thumbColor="#FFF"
              />
            </View>

            <View style={s.switchRow}>
              <View style={s.switchText}>
                <Text style={s.switchTitle}>{t('settings.daemonTls')}</Text>
                <Text style={s.switchValue}>
                  {draft.useSsl ? t('common.on') : t('common.off')}
                </Text>
              </View>
              <Switch
                value={draft.useSsl}
                onValueChange={value => updateDraft('useSsl', value)}
                trackColor={{ false: colors.surface, true: colors.orange }}
                thumbColor="#FFF"
              />
            </View>

            <View style={s.nodeActions}>
              <TouchableOpacity
                style={s.secondaryButton}
                activeOpacity={0.75}
                onPress={resetNodeDefaults}
              >
                <Text style={s.secondaryButtonText}>{t('action.reset')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  s.primaryButton,
                  (!canSave || !hasChanges || isSavingNodeSettings) &&
                    s.primaryButtonDisabled,
                ]}
                activeOpacity={0.8}
                disabled={!canSave || !hasChanges || isSavingNodeSettings}
                onPress={saveNodeSettings}
              >
                <Icon name="check" size={18} color="#FFF" />
                <Text style={s.primaryButtonText}>
                  {isSavingNodeSettings ? t('action.saving') : t('action.save')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={s.section}>
          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionTitle}>{t('settings.diagnostics')}</Text>
            <Text
              style={[
                s.nodeStatus,
                diagnosticsStatusText !== 'Ready' && s.nodeStatusDirty,
              ]}
            >
              {displayedDiagnosticsStatus}
            </Text>
          </View>
          <View style={s.nodePanel}>
            {isRunningDiagnostics && diagnosticProgress ? (
              <View style={s.diagnosticProgress}>
                <Text style={s.diagnosticProgressTitle}>
                  {diagnosticProgress.label}
                </Text>
                <Text style={s.diagnosticProgressValue}>
                  {diagnosticProgress.completed}/{diagnosticProgress.total}
                </Text>
                <View style={s.diagnosticProgressTrack}>
                  <View
                    style={[
                      s.diagnosticProgressFill,
                      {
                        width: `${Math.round(
                          (diagnosticProgress.completed /
                            Math.max(1, diagnosticProgress.total)) *
                            100,
                        )}%`,
                      },
                    ]}
                  />
                </View>
              </View>
            ) : null}

            {diagnosticReport ? (
              <View style={s.diagnosticList}>
                <View style={s.diagnosticSummary}>
                  <DiagnosticCount label="Passed" value={diagnosticReport.passed} tone="pass" />
                  <DiagnosticCount label="Warnings" value={diagnosticReport.warnings} tone="warning" />
                  <DiagnosticCount label="Failed" value={diagnosticReport.failed} tone="fail" />
                  <DiagnosticCount label="Skipped" value={diagnosticReport.skipped} tone="skipped" />
                </View>
                {diagnosticReport.tests.map(test => (
                  <View key={test.id} style={s.diagnosticTest}>
                    <View style={s.diagnosticTestHeader}>
                      <View style={s.diagnosticTestHeading}>
                        <Text style={s.diagnosticCategory}>{test.category}</Text>
                        <Text style={s.diagnosticTestTitle}>{test.label}</Text>
                      </View>
                      <Text
                        style={[
                          s.diagnosticBadge,
                          diagnosticStatusStyle(test.status),
                        ]}
                      >
                        {test.status.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={s.diagnosticSummaryText}>{test.summary}</Text>
                    {test.metrics.length > 0 ? (
                      <View style={s.diagnosticMetrics}>
                        {test.metrics.map(metric => (
                          <View key={`${test.id}-${metric.label}`} style={s.diagnosticMetric}>
                            <Text style={s.diagnosticMetricLabel}>{metric.label}</Text>
                            <Text style={s.diagnosticMetricValue}>
                              {metric.value}{metric.unit ? ` ${metric.unit}` : ''}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <Text style={s.diagnosticDuration}>{test.durationMs} ms</Text>
                  </View>
                ))}
                <Text style={s.diagnosticRunDuration}>
                  Total test time: {diagnosticReport.durationMs} ms
                </Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[
                s.primaryButton,
                isRunningDiagnostics && s.primaryButtonDisabled,
              ]}
              activeOpacity={0.8}
              disabled={isRunningDiagnostics}
              onPress={runSettingsDiagnostics}
            >
              <Icon name="info" size={18} color="#FFF" />
              <Text style={s.primaryButtonText}>
                {isRunningDiagnostics
                  ? t('status.running')
                  : t('action.runDiagnostics')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                s.secondaryButton,
                isSendingTestPush && s.primaryButtonDisabled,
              ]}
              activeOpacity={0.8}
              disabled={isSendingTestPush}
              onPress={sendTestPush}
            >
              <Text style={s.secondaryButtonText}>
                {isSendingTestPush ? 'Sending test…' : 'Send test notification'}
              </Text>
            </TouchableOpacity>
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

type Translator = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

function translateStatusText(value: string, t: Translator): string {
  switch (value) {
    case 'Applied':
      return t('status.applied');
    case 'Creating':
      return t('status.creating');
    case 'Default':
      return t('settings.default');
    case 'Error':
      return t('status.error');
    case 'Loading':
      return t('settings.loading');
    case 'Off':
      return t('common.off');
    case 'Ready':
      return t('status.ready');
    case 'Running':
      return t('status.running');
    case 'Saved':
      return t('status.saved');
    case 'Saving':
      return t('action.saving');
    case 'Unsaved':
      return t('settings.unsaved');
    case 'Warnings':
      return t('status.warnings');
    default:
      return value;
  }
}

function NodeInput({
  label,
  value,
  onChangeText,
  placeholder,
  editable = true,
  secureTextEntry = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  editable?: boolean;
  secureTextEntry?: boolean;
}) {
  return (
    <View style={s.inputGroup}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        editable={editable}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
        autoCorrect={false}
        style={[s.input, !editable && s.inputDisabled]}
      />
    </View>
  );
}

function DiagnosticCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'pass' | 'warning' | 'fail' | 'skipped';
}) {
  return (
    <View style={s.diagnosticCount}>
      <Text style={[s.diagnosticCountValue, diagnosticStatusStyle(tone)]}>
        {value}
      </Text>
      <Text style={s.diagnosticCountLabel}>{label}</Text>
    </View>
  );
}

function diagnosticStatusStyle(
  status: 'pass' | 'warning' | 'fail' | 'skipped',
) {
  switch (status) {
    case 'pass':
      return { color: colors.success };
    case 'warning':
      return { color: colors.warning };
    case 'fail':
      return { color: colors.error };
    default:
      return { color: colors.textMuted };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 60 },
  header: { alignItems: 'center', marginBottom: 32, gap: 8 },
  title: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    marginTop: 8,
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
  rowDisabled: { opacity: 0.5 },
  rowCopy: { flex: 1, gap: 3 },
  rowHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
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
