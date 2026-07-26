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
import { runWalletDiagnostics } from '../services/WalletDiagnostics';
import { walletService } from '../services/WalletService';
import { useWalletState } from '../services/WalletState';
import {
  type AppProtectionMode,
  useAppSecurity,
} from '../services/AppSecurity';
import {
  loadFastWalletPreference,
  saveFastWalletPreference,
  type FastWalletPreference,
} from '../services/FastWalletPreference';

type DiagnosticRow = {
  label: string;
  value: string;
  warning?: boolean;
};

type WalletDiagnosticsResult = Awaited<ReturnType<typeof runWalletDiagnostics>>;

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
  const { registeredWallet, session } = useWalletState();
  const { mode: savedProtectionMode, setMode: setAppProtectionMode } =
    useAppSecurity();
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
  const [diagnosticRows, setDiagnosticRows] = useState<DiagnosticRow[]>([]);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);
  const [isRevealingSeed, setIsRevealingSeed] = useState(false);
  const [protectionMode, setProtectionMode] =
    useState<AppProtectionMode>(savedProtectionMode);
  const [appPassword, setAppPassword] = useState('');
  const [confirmAppPassword, setConfirmAppPassword] = useState('');
  const [isSavingAppProtection, setIsSavingAppProtection] = useState(false);
  const [fastWalletPreference, setFastWalletPreference] =
    useState<FastWalletPreference>('disabled');

  useEffect(() => {
    setProtectionMode(savedProtectionMode);
  }, [savedProtectionMode]);

  useEffect(() => {
    let mounted = true;
    void loadFastWalletPreference().then(preference => {
      if (mounted && preference) setFastWalletPreference(preference);
    });
    return () => {
      mounted = false;
    };
  }, []);

  function changeFastWalletPreference(enabled: boolean) {
    const next: FastWalletPreference = enabled ? 'enabled' : 'disabled';
    setFastWalletPreference(next);
    void saveFastWalletPreference(next).catch(() => undefined);
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
      const diagnostics = await runWalletDiagnostics('settings');
      setDiagnosticRows(createDiagnosticRows(diagnostics));
      setDiagnosticsStatusText(
        diagnostics.errors.length > 0 ? 'Warnings' : 'Ready',
      );
    } catch (error) {
      setDiagnosticRows([
        {
          label: 'Error',
          value: errorMessage(error),
          warning: true,
        },
      ]);
      setDiagnosticsStatusText('Error');
    } finally {
      setIsRunningDiagnostics(false);
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

  async function saveAppProtection() {
    if (protectionMode === 'password') {
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
    }

    setIsSavingAppProtection(true);
    try {
      await setAppProtectionMode(
        protectionMode,
        protectionMode === 'password' ? appPassword : undefined,
      );
      setAppPassword('');
      setConfirmAppPassword('');
      Alert.alert(
        t('settings.appProtection'),
        t('settings.appProtectionSaved'),
      );
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
          <Text style={s.version}>Version 1.0.0 (MVP)</Text>
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
            {protectionMode === 'password' ? (
              <>
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
            ) : null}
            <TouchableOpacity
              activeOpacity={0.8}
              disabled={
                isSavingAppProtection ||
                (protectionMode === 'password' &&
                  (!appPassword || !confirmAppPassword))
              }
              onPress={() => void saveAppProtection()}
              style={[
                s.secondaryButton,
                (isSavingAppProtection ||
                  (protectionMode === 'password' &&
                    (!appPassword || !confirmAppPassword))) &&
                  s.primaryButtonDisabled,
              ]}
            >
              <Text style={s.secondaryButtonText}>
                {isSavingAppProtection
                  ? t('action.working')
                  : t('settings.saveAppProtection')}
              </Text>
            </TouchableOpacity>
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
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>Privacy mode</Text>
          <View style={s.nodePanel}>
            <Text style={s.passwordHint}>
              Choose the default for future normal and Ledger wallets. Existing
              wallets are unchanged.
            </Text>
            <View style={s.segmented}>
              <TouchableOpacity
                style={[
                  s.segment,
                  fastWalletPreference === 'disabled' && s.segmentActive,
                ]}
                activeOpacity={0.75}
                onPress={() => changeFastWalletPreference(false)}
              >
                <Text
                  style={[
                    s.segmentText,
                    fastWalletPreference === 'disabled' && s.segmentTextActive,
                  ]}
                >
                  Privacy only
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  s.segment,
                  fastWalletPreference === 'enabled' && s.segmentActive,
                ]}
                activeOpacity={0.75}
                onPress={() => changeFastWalletPreference(true)}
              >
                <Text
                  style={[
                    s.segmentText,
                    fastWalletPreference === 'enabled' && s.segmentTextActive,
                  ]}
                >
                  Privacy + comfort
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={s.switchValue}>
              {fastWalletPreference === 'enabled'
                ? 'Privacy + comfort adds a separate Fast Wallet for quick incoming-payment alerts. Your normal wallet stays unchanged.'
                : 'Privacy only creates normal local wallets by default. You can add a Fast Wallet later.'}{' '}
              Scanner hosting always needs separate approval.
            </Text>
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
            {diagnosticRows.length > 0 ? (
              <View style={s.diagnosticList}>
                {diagnosticRows.map(row => (
                  <View key={row.label} style={s.diagnosticRow}>
                    <Text style={s.diagnosticLabel}>{row.label}</Text>
                    <Text
                      style={[
                        s.diagnosticValue,
                        row.warning && s.diagnosticValueWarning,
                      ]}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {row.value}
                    </Text>
                  </View>
                ))}
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
          </View>
        </View>

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

function createDiagnosticRows(
  diagnostics: WalletDiagnosticsResult,
): DiagnosticRow[] {
  const rows: DiagnosticRow[] = [
    {
      label: 'Mode',
      value: diagnostics.settings?.mode ?? 'Default',
    },
    {
      label: 'Daemon',
      value: formatDaemonDiagnostic(diagnostics.daemon.getInfo),
      warning: isDaemonWarning(diagnostics.daemon.getInfo),
    },
    {
      label: 'JSON RPC',
      value: formatDaemonDiagnostic(diagnostics.daemon.jsonRpcGetInfo),
      warning: isDaemonWarning(diagnostics.daemon.jsonRpcGetInfo),
    },
    {
      label: 'gRPC',
      value: diagnostics.settings?.grpcConfigured ? 'Configured' : 'Disabled',
    },
    {
      label: 'Native',
      value: diagnostics.native.linkedWithMonero ? 'Linked' : 'Missing',
      warning: !diagnostics.native.linkedWithMonero,
    },
    {
      label: 'Wallet',
      value: formatWalletDiagnostic(diagnostics),
    },
    {
      label: 'Fast Wallet view key',
      value: formatFastWalletDiagnostic(diagnostics.fastWallet),
      warning: isFastWalletDiagnosticWarning(diagnostics.fastWallet),
    },
    {
      label: 'Ledger',
      value: formatLedgerDiagnostic(diagnostics.ledgerTransport),
      warning: diagnostics.ledgerTransport
        ? diagnostics.ledgerTransport.requiresUserAction
        : false,
    },
  ];

  if (diagnostics.errors.length > 0) {
    rows.push({
      label: 'Errors',
      value: String(diagnostics.errors.length),
      warning: true,
    });
  }

  return rows;
}

function formatDaemonDiagnostic(
  result: WalletDiagnosticsResult['daemon']['getInfo'],
): string {
  if (!result) {
    return 'Not configured';
  }
  if (result.error) {
    return 'Error';
  }
  if (!result.ok) {
    return result.httpStatus ? `HTTP ${result.httpStatus}` : 'Unavailable';
  }

  const status = toDisplayValue(result.status, 'OK');
  const height = toDisplayValue(result.height, '?');
  const sync = result.synchronized === true ? 'synced' : 'syncing';
  return `${status} ${sync} ${height}`;
}

function isDaemonWarning(
  result: WalletDiagnosticsResult['daemon']['getInfo'],
): boolean {
  return !result || Boolean(result.error) || !result.ok;
}

function formatWalletDiagnostic(diagnostics: WalletDiagnosticsResult): string {
  if (diagnostics.snapshot) {
    const walletHeight = toDisplayValue(diagnostics.snapshot.walletHeight, '?');
    const daemonHeight = toDisplayValue(diagnostics.snapshot.daemonHeight, '?');
    return diagnostics.snapshot.synchronized
      ? `Synced ${walletHeight}`
      : `${walletHeight}/${daemonHeight}`;
  }

  return diagnostics.registeredWallet ? 'Registered' : 'None';
}

function formatFastWalletDiagnostic(
  fastWallet: WalletDiagnosticsResult['fastWallet'],
): string {
  if (fastWallet.configuredCount === 0) {
    return 'Not configured';
  }
  if (fastWallet.checkedCount === 0) {
    return 'Check failed';
  }
  if (fastWallet.hostedCount === 0) {
    return `Not hosted 0/${fastWallet.configuredCount}`;
  }
  return `Hosted ${fastWallet.hostedCount}/${fastWallet.configuredCount}`;
}

function isFastWalletDiagnosticWarning(
  fastWallet: WalletDiagnosticsResult['fastWallet'],
): boolean {
  return (
    fastWallet.configuredCount > 0 &&
    (fastWallet.checkedCount < fastWallet.configuredCount ||
      fastWallet.hostedCount < fastWallet.configuredCount)
  );
}

function formatLedgerDiagnostic(
  status: WalletDiagnosticsResult['ledgerTransport'],
): string {
  if (!status) {
    return 'Unknown';
  }
  if (!status.supported) {
    return 'Unsupported';
  }
  if (!status.available) {
    return 'Not connected';
  }
  if (status.permissionGranted) {
    return status.deviceName || 'Ready';
  }
  return status.message || 'Permission';
}

function toDisplayValue(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
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
  diagnosticValueWarning: { color: colors.warning },
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
  bottomSpacer: { height: 24 },
});
