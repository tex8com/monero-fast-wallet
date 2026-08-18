import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Icon} from '../components/Icon';
import {useI18n} from '../i18n';
import {colors, radius, spacing} from '../theme/colors';
import type {MoneroNetwork} from '../services/NativeMoneroWallet';
import {
  createDefaultNodeConnectionSettings,
  getActiveNodeConnectionSettings,
  loadActiveNodeConnectionSettings,
  nodeConnectionDraftToSettings,
  nodeConnectionSettingsToDraft,
  saveActiveNodeConnectionSettings,
  type NodeConnectionDraft,
} from '../services/NodeConnectionSettings';
import {
  fixedMainnetNodeConnection,
  type FixedNodeId,
} from '../../../../packages/wallet-shared/src/nodePresets';
import {
  diagnoseConnectionRoutes,
  type ConnectionDiagnosticsResult,
  type ConnectionRouteResult,
} from '../services/ConnectionDiagnostics';
import {walletService} from '../services/WalletService';

const NETWORKS: ReadonlyArray<{value: MoneroNetwork; label: string}> = [
  {value: 'mainnet', label: 'Mainnet'},
  {value: 'testnet', label: 'Testnet'},
  {value: 'stagenet', label: 'Stagenet'},
];
const KNOWN_NODE_IDS: ReadonlyArray<FixedNodeId> = ['tex8', 'community'];
const AUTO_SAVE_DELAY_MS = 550;

type SaveState = 'loading' | 'saved' | 'saving' | 'error';

export default function NodeStatusScreen({navigation}: any) {
  const {t} = useI18n();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<NodeConnectionDraft>(() =>
    nodeConnectionSettingsToDraft(getActiveNodeConnectionSettings()),
  );
  const [persistedFingerprint, setPersistedFingerprint] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [diagnostics, setDiagnostics] =
    useState<ConnectionDiagnosticsResult | null>(null);
  const [diagnosticsRunning, setDiagnosticsRunning] = useState(false);
  const editRevision = useRef(0);
  const saveQueue = useRef(Promise.resolve());

  const resolvedSettings = useMemo(
    () => nodeConnectionDraftToSettings(draft),
    [draft],
  );
  const currentFingerprint = useMemo(
    () => JSON.stringify(resolvedSettings),
    [resolvedSettings],
  );
  const valid =
    resolvedSettings.daemon.address.length > 0 &&
    resolvedSettings.grpcEndpoint.length > 0;

  const runDiagnostics = useCallback(async (settings = resolvedSettings) => {
    setDiagnosticsRunning(true);
    try {
      setDiagnostics(await diagnoseConnectionRoutes(settings));
    } finally {
      setDiagnosticsRunning(false);
    }
  }, [resolvedSettings]);

  useEffect(() => {
    let mounted = true;
    loadActiveNodeConnectionSettings()
      .then(settings => {
        if (!mounted) return;
        setDraft(nodeConnectionSettingsToDraft(settings));
        setPersistedFingerprint(JSON.stringify(settings));
        setSaveState('saved');
        setDiagnosticsRunning(true);
        diagnoseConnectionRoutes(settings)
          .then(result => {
            if (mounted) setDiagnostics(result);
          })
          .finally(() => {
            if (mounted) setDiagnosticsRunning(false);
          });
      })
      .catch(() => {
        if (mounted) setSaveState('error');
      });
    return () => {
      mounted = false;
    };
  }, []); // Deliberately load the one global profile only once.

  useEffect(() => {
    if (!persistedFingerprint || currentFingerprint === persistedFingerprint) {
      return;
    }
    setDiagnostics(null);
    if (!valid) {
      setSaveState('error');
      return;
    }

    const revision = ++editRevision.current;
    setSaveState('saving');
    const timeout = setTimeout(() => {
      const settingsToSave = resolvedSettings;
      saveQueue.current = saveQueue.current
        .then(async () => {
          if (revision !== editRevision.current) return;
          const saved = await saveActiveNodeConnectionSettings(settingsToSave);
          await walletService.applyNodeConnectionToActive(saved);
          await walletService
            .refreshFastReceiveRegistrationStatusesForSettings(saved)
            .catch(() => undefined);
          if (revision !== editRevision.current) return;
          setPersistedFingerprint(JSON.stringify(saved));
          setSaveState('saved');
        })
        .catch(() => {
          if (revision === editRevision.current) setSaveState('error');
        });
    }, AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [currentFingerprint, persistedFingerprint, resolvedSettings, valid]);

  function setNetwork(network: MoneroNetwork) {
    setDraft(
      nodeConnectionSettingsToDraft(
        createDefaultNodeConnectionSettings(network, 'optimized-grpc'),
      ),
    );
  }

  function updateEndpoint(
    key: 'daemonAddress' | 'grpcEndpoint',
    value: string,
  ) {
    setDraft(current => ({
      ...current,
      mode: 'optimized-grpc',
      [key]: value,
      ...(key === 'daemonAddress'
        ? {proxyAddress: '127.0.0.1:9050'}
        : undefined),
    }));
  }

  function choosePreset(node: FixedNodeId, transport: 'clearnet' | 'onion') {
    const preset = fixedMainnetNodeConnection(node, transport);
    setDraft(current => ({
      ...current,
      mode: 'optimized-grpc',
      network: 'mainnet',
      ...(transport === 'clearnet'
        ? {grpcEndpoint: preset.grpcEndpoint}
        : {
            daemonAddress: preset.daemonAddress,
            proxyAddress: preset.proxyAddress,
            trusted: true,
            useSsl: false,
          }),
    }));
  }

  function renderPreset(node: FixedNodeId, transport: 'clearnet' | 'onion') {
    const preset = fixedMainnetNodeConnection(node, transport);
    const nodeLabel =
      node === 'tex8' ? t('settings.tex8Node') : t('settings.communityNode');
    const transportLabel =
      transport === 'clearnet'
        ? t('settings.clearnetAddress')
        : t('settings.onionAddress');
    const endpoint =
      transport === 'clearnet' ? preset.grpcEndpoint : preset.daemonAddress;
    const selected =
      transport === 'clearnet'
        ? draft.grpcEndpoint.trim() === endpoint
        : draft.daemonAddress.trim() === endpoint;
    return (
      <TouchableOpacity
        accessibilityLabel={`${nodeLabel}, ${transportLabel}`}
        accessibilityRole="radio"
        accessibilityState={{selected}}
        activeOpacity={0.75}
        key={`${transport}-${node}`}
        onPress={() => choosePreset(node, transport)}
        style={[s.preset, selected && s.presetSelected]}
      >
        <View style={s.presetCopy}>
          <Text style={s.presetName}>
            {nodeLabel}
          </Text>
          <Text numberOfLines={2} style={s.endpointSmall}>
            {endpoint}
          </Text>
        </View>
        {selected ? <Icon name="check" size={17} color={colors.orange} /> : null}
      </TouchableOpacity>
    );
  }

  const saveLabel =
    saveState === 'loading'
      ? t('settings.loading')
      : saveState === 'saving'
        ? t('nodeStatus.autoSaving')
        : saveState === 'saved'
          ? t('nodeStatus.autoSaved')
          : t('nodeStatus.autoSaveError');

  return (
    <View style={s.container}>
      <ScrollView
        contentContainerStyle={[
          s.scroll,
          {paddingBottom: Math.max(180, insets.bottom + 150)},
        ]}
      >
        <TouchableOpacity
          accessibilityRole="button"
          activeOpacity={0.7}
          onPress={() => navigation.goBack()}
          style={s.back}
        >
          <Icon name="arrow-left" size={18} color={colors.textMuted} />
          <Text style={s.backText}>{t('action.back')}</Text>
        </TouchableOpacity>
        <View style={s.headerRow}>
          <View style={s.headerCopy}>
            <Text style={s.title}>{t('menu.nodeStatus')}</Text>
            <Text style={s.subtitle}>{t('nodeStatus.subtitle')}</Text>
          </View>
          <Text
            style={[
              s.saveStatus,
              saveState === 'error' && s.errorText,
              saveState === 'saving' && s.warningText,
            ]}
          >
            {saveLabel}
          </Text>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{t('nodeStatus.diagnostics')}</Text>
          <Text style={s.sectionHint}>{t('nodeStatus.diagnosticsHint')}</Text>
          <RouteCard
            icon="onion"
            label={t('nodeStatus.torRoute')}
            hint={t('nodeStatus.torHint')}
            result={diagnostics?.tor}
            running={diagnosticsRunning}
            t={t}
          />
          <RouteCard
            icon="globe"
            label={t('nodeStatus.clearnetRoute')}
            hint={t('nodeStatus.clearnetHint')}
            result={diagnostics?.clearnet}
            running={diagnosticsRunning}
            t={t}
          />
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.8}
            disabled={diagnosticsRunning || !valid}
            onPress={() => runDiagnostics()}
            style={[
              s.secondaryButton,
              (diagnosticsRunning || !valid) && s.buttonDisabled,
            ]}
          >
            <Text style={s.secondaryButtonText}>
              {diagnosticsRunning
                ? t('status.running')
                : t('action.runDiagnostics')}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{t('nodeStatus.globalRoutes')}</Text>
          <Text style={s.sectionHint}>{t('nodeStatus.globalRoutesHint')}</Text>
          <View style={s.segmented}>
            {NETWORKS.map(network => (
              <TouchableOpacity
                accessibilityRole="radio"
                accessibilityState={{selected: draft.network === network.value}}
                key={network.value}
                onPress={() => setNetwork(network.value)}
                style={[
                  s.segment,
                  draft.network === network.value && s.segmentActive,
                ]}
              >
                <Text
                  adjustsFontSizeToFit
                  numberOfLines={1}
                  style={[
                    s.segmentText,
                    draft.network === network.value && s.segmentTextActive,
                  ]}
                >
                  {network.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <RouteSettings
          icon="globe"
          title={t('settings.clearnetSyncRoute')}
          hint={t('nodeStatus.clearnetHint')}
        >
          {draft.network === 'mainnet' ? (
            <View style={s.presetList}>
              {KNOWN_NODE_IDS.map(node => renderPreset(node, 'clearnet'))}
            </View>
          ) : null}
          <EndpointInput
            label={t('settings.clearnetGrpcEndpoint')}
            onChangeText={value => updateEndpoint('grpcEndpoint', value)}
            placeholder="xmr.tex8.com:18091"
            value={draft.grpcEndpoint}
          />
        </RouteSettings>

        <RouteSettings
          icon="onion"
          title={t('settings.onionDaemonRoute')}
          hint={t('nodeStatus.torHint')}
        >
          {draft.network === 'mainnet' ? (
            <View style={s.presetList}>
              {KNOWN_NODE_IDS.map(node => renderPreset(node, 'onion'))}
            </View>
          ) : null}
          <EndpointInput
            label={t('settings.onionDaemonEndpoint')}
            onChangeText={value => updateEndpoint('daemonAddress', value)}
            placeholder="node-address.onion:18089"
            value={draft.daemonAddress}
          />
        </RouteSettings>

        <TouchableOpacity
          accessibilityRole="button"
          activeOpacity={0.75}
          onPress={() =>
            setDraft(
              nodeConnectionSettingsToDraft(
                createDefaultNodeConnectionSettings(
                  draft.network,
                  'optimized-grpc',
                ),
              ),
            )
          }
          style={s.secondaryButton}
        >
          <Text style={s.secondaryButtonText}>{t('action.reset')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function RouteCard({
  icon,
  label,
  hint,
  result,
  running,
  t,
}: {
  icon: 'onion' | 'globe';
  label: string;
  hint: string;
  result: ConnectionRouteResult | undefined;
  running: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const connected = result?.status === 'connected';
  const status = running
    ? t('nodeStatus.checking')
    : connected
      ? t('nodeStatus.connected')
      : result
        ? t('nodeStatus.notConnected')
        : t('status.pending');
  return (
    <View style={s.routeCard}>
      <View style={s.routeHeader}>
        <View style={s.routeIcon}>
          <Icon name={icon} size={20} color={colors.orange} />
        </View>
        <View style={s.routeCopy}>
          <Text style={s.routeTitle}>{label}</Text>
          <Text style={s.routeHint}>{hint}</Text>
        </View>
        <Text
          style={[
            s.routeStatus,
            connected && s.connectedText,
            result?.status === 'error' && s.errorText,
          ]}
        >
          {status}
        </Text>
      </View>
      {result?.endpoint ? (
        <Text selectable style={s.endpointSmall}>{result.endpoint}</Text>
      ) : null}
      {connected && result?.elapsedMs !== undefined ? (
        <Text style={s.detailText}>{result.elapsedMs} ms</Text>
      ) : null}
      {result?.error ? <Text style={s.errorDetail}>{result.error}</Text> : null}
    </View>
  );
}

function RouteSettings({
  icon,
  title,
  hint,
  children,
}: React.PropsWithChildren<{
  icon: 'onion' | 'globe';
  title: string;
  hint: string;
}>) {
  return (
    <View style={s.section}>
      <View style={s.routeSettingsTitle}>
        <Icon name={icon} size={19} color={colors.orange} />
        <Text style={s.sectionTitleInline}>{title}</Text>
      </View>
      <Text style={s.sectionHint}>{hint}</Text>
      {children}
    </View>
  );
}

function EndpointInput({
  label,
  value,
  onChangeText,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
}) {
  return (
    <View style={s.inputGroup}>
      <Text style={s.inputLabel}>{label}</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        style={s.input}
        value={value}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  scroll: {paddingHorizontal: spacing.lg, paddingTop: 14, gap: 18},
  back: {alignItems: 'center', flexDirection: 'row', gap: 5, alignSelf: 'flex-start'},
  backText: {color: colors.textMuted, fontSize: 14, fontWeight: '700'},
  headerRow: {alignItems: 'flex-start', flexDirection: 'row', gap: 12},
  headerCopy: {flex: 1, gap: 5},
  title: {color: colors.textPrimary, fontSize: 28, fontWeight: '800'},
  subtitle: {color: colors.textMuted, fontSize: 13, lineHeight: 19},
  saveStatus: {color: colors.success, fontSize: 11, fontWeight: '800', paddingTop: 7},
  section: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 10,
    padding: spacing.md,
  },
  sectionTitle: {color: colors.textPrimary, fontSize: 16, fontWeight: '800'},
  sectionTitleInline: {color: colors.textPrimary, fontSize: 15, fontWeight: '800'},
  sectionHint: {color: colors.textMuted, fontSize: 12, lineHeight: 18},
  routeCard: {
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 7,
    padding: 12,
  },
  routeHeader: {alignItems: 'center', flexDirection: 'row', gap: 10},
  routeIcon: {alignItems: 'center', justifyContent: 'center', width: 28},
  routeCopy: {flex: 1, gap: 2},
  routeTitle: {color: colors.textPrimary, fontSize: 14, fontWeight: '800'},
  routeHint: {color: colors.textMuted, fontSize: 10, lineHeight: 14},
  routeStatus: {color: colors.warning, fontSize: 10, fontWeight: '900'},
  connectedText: {color: colors.success},
  errorText: {color: colors.error},
  warningText: {color: colors.warning},
  errorDetail: {color: colors.error, fontSize: 11, lineHeight: 16},
  detailText: {color: colors.success, fontSize: 10, fontWeight: '700'},
  endpointSmall: {color: colors.textMuted, fontFamily: 'monospace', fontSize: 9, lineHeight: 13},
  segmented: {
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    padding: 4,
  },
  segment: {alignItems: 'center', borderRadius: radius.sm, flex: 1, justifyContent: 'center', minHeight: 38, paddingHorizontal: 5},
  segmentActive: {backgroundColor: colors.orange},
  segmentText: {color: colors.textSecondary, fontSize: 11, fontWeight: '800'},
  segmentTextActive: {color: '#FFF'},
  presetList: {gap: 7},
  preset: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  presetSelected: {backgroundColor: colors.orangeMuted, borderColor: colors.orange},
  presetCopy: {flex: 1, gap: 3},
  presetName: {color: colors.textPrimary, fontSize: 13, fontWeight: '800'},
  routeSettingsTitle: {alignItems: 'center', flexDirection: 'row', gap: 8},
  inputGroup: {gap: 6},
  inputLabel: {color: colors.textSecondary, fontSize: 11, fontWeight: '700'},
  input: {
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: 13,
    minHeight: 46,
    paddingHorizontal: 13,
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 46,
  },
  secondaryButtonText: {color: colors.textPrimary, fontSize: 13, fontWeight: '800'},
  buttonDisabled: {opacity: 0.45},
});
