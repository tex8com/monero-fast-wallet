import {useFocusEffect} from '@react-navigation/native';
import React, {useCallback, useMemo, useState} from 'react';
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
import WalletSelector, {
  type WalletOption,
  type WalletSelectorItem,
} from '../components/WalletSelector';
import {useI18n} from '../i18n';
import {
  createVanitySearchDraft,
  VANITY_MAX_PREFIX_LENGTH,
  VANITY_MAX_PREFIXES,
} from '../services/VanityRequest';
import {
  getLatestVanityOrderId,
  getVanityOrderStatus,
  type VanityOrderStatus,
} from '../services/VanityServiceClient';
import {walletDisplayName, type RegisteredWallet} from '../services/WalletRegistry';
import {useWalletState} from '../services/WalletState';
import {colors, radius, spacing} from '../theme/colors';

const MONERO_BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
type PrefixField = Readonly<{id: number; value: string}>;

function validPrefix(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= VANITY_MAX_PREFIX_LENGTH &&
    value.startsWith('4') &&
    [...value].every(character => MONERO_BASE58.includes(character))
  );
}

function prefixHint(value: string, duplicate: boolean): string {
  if (duplicate) return 'Each requested prefix must be different.';
  if (!value || value === '4') return 'Use 2–10 Monero Base58 characters.';
  if (!validPrefix(value)) return 'Choose a mainnet prefix starting with 4.';
  return 'The worker will search for this public prefix.';
}

function orderStatusLabel(value: string): string {
  switch (value) {
    case 'awaiting_payment': return 'Waiting for payment';
    case 'payment_seen': return 'Payment detected';
    case 'paid': return 'Payment confirmed';
    case 'queued': return 'Waiting for a GPU slot';
    case 'searching': return 'Searching';
    case 'completed': return 'Address found';
    case 'partially_completed': return 'Partially completed';
    case 'expired': return 'Search expired';
    default: return value.replaceAll('_', ' ');
  }
}

export default function VanityAddressScreen({navigation}: any) {
  const {t} = useI18n();
  const insets = useSafeAreaInsets();
  const {
    isRegisteredWalletOpen,
    openRegisteredWalletById,
    registeredWallet,
    registeredWallets,
    setActiveRegisteredWallet,
    snapshot,
    walletSnapshots,
  } = useWalletState();
  const [prefixFields, setPrefixFields] = useState<PrefixField[]>([
    {id: 1, value: '4'},
  ]);
  const [notice, setNotice] = useState<string | undefined>();
  const [openingWalletId, setOpeningWalletId] = useState<string | undefined>();
  const [latestOrderId, setLatestOrderId] = useState<string | undefined>();
  const [latestOrder, setLatestOrder] = useState<VanityOrderStatus | undefined>();
  const [latestOrderLoading, setLatestOrderLoading] = useState(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLatestOrderLoading(true);
    void getLatestVanityOrderId().then(async orderId => {
      if (!active) return;
      setLatestOrderId(orderId);
      if (!orderId) {
        setLatestOrder(undefined);
        return;
      }
      const order = await getVanityOrderStatus(orderId);
      if (active) setLatestOrder(order);
    }).catch(() => {
      if (active) setLatestOrder(undefined);
    }).finally(() => {
      if (active) setLatestOrderLoading(false);
    });
    return () => { active = false; };
  }, []));

  const walletSnapshotMap = useMemo(
    () => ({
      ...walletSnapshots,
      ...(registeredWallet && snapshot ? {[registeredWallet.id]: snapshot} : {}),
    }),
    [registeredWallet, snapshot, walletSnapshots],
  );
  const selectedWalletSnapshot = registeredWallet
    ? walletSnapshotMap[registeredWallet.id]
    : undefined;
  const selectedSnapshotMatchesWallet = Boolean(
    registeredWallet &&
      selectedWalletSnapshot &&
      selectedWalletSnapshot.path === registeredWallet.path,
  );
  const publicAddress = selectedSnapshotMatchesWallet
    ? selectedWalletSnapshot?.primaryAddress
    : undefined;
  const usableWallet =
    registeredWallet?.kind === 'software' &&
    registeredWallet.network === 'mainnet' &&
    Boolean(publicAddress);
  const vanityWalletOptions = useMemo<WalletSelectorItem[]>(
    () =>
      registeredWallets.map(wallet =>
        wallet.kind === 'software' && wallet.network === 'mainnet'
          ? wallet
          : unsupportedWalletOption(wallet),
      ),
    [registeredWallets],
  );
  const prefixes = prefixFields.map(field => field.value);
  const validPrefixes =
    prefixFields.length >= 1 &&
    prefixFields.length <= VANITY_MAX_PREFIXES &&
    prefixes.every(validPrefix) &&
    new Set(prefixes).size === prefixes.length;

  function updatePrefix(id: number, value: string) {
    setNotice(undefined);
    const base58 = value
      .replace(/[^123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]/g, '')
      .slice(0, VANITY_MAX_PREFIX_LENGTH);
    const nextValue = (base58.startsWith('4') ? base58 : `4${base58}`).slice(
      0,
      VANITY_MAX_PREFIX_LENGTH,
    );
    setPrefixFields(current =>
      current.map(field => (field.id === id ? {...field, value: nextValue} : field)),
    );
  }

  function addPrefix() {
    setNotice(undefined);
    setPrefixFields(current =>
      current.length >= VANITY_MAX_PREFIXES
        ? current
        : [
            ...current,
            {id: Math.max(...current.map(field => field.id)) + 1, value: '4'},
          ],
    );
  }

  function removePrefix(id: number) {
    if (prefixFields.length <= 1) return;
    setNotice(undefined);
    setPrefixFields(current => current.filter(field => field.id !== id));
  }

  async function selectWallet(wallet: WalletOption) {
    if (wallet.disabled) return;
    setNotice(undefined);
    setOpeningWalletId(wallet.id);
    try {
      if (isRegisteredWalletOpen(wallet.id)) {
        if (wallet.id !== registeredWallet?.id) {
          await setActiveRegisteredWallet(wallet.id);
        }
        return;
      }
      const opened = await openRegisteredWalletById(wallet.id);
      if (!opened) {
        setNotice('Open the selected wallet before starting generation.');
      }
    } catch {
      setNotice('The selected wallet could not be opened.');
    } finally {
      setOpeningWalletId(undefined);
    }
  }

  function continueToPayment() {
    if (
      !usableWallet ||
      !validPrefixes ||
      !registeredWallet ||
      !publicAddress
    ) return;
    try {
      const request = createVanitySearchDraft({
        sourceWalletRegistrationId: registeredWallet.id,
        walletKind: registeredWallet.kind,
        network: registeredWallet.network,
        sourcePublicAddress: publicAddress,
        prefixes,
      });
      navigation.navigate('VanityPayment', {vanityRequest: request});
    } catch {
      setNotice('The selected wallet data is not ready for a vanity request.');
    }
  }

  return (
    <View style={s.container}>
      <ScrollView
        contentContainerStyle={[s.scroll, {paddingBottom: Math.max(170, insets.bottom + 140)}]}
        keyboardShouldPersistTaps="handled"
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

        <View style={s.titleRow}>
          <View style={s.heroIcon}>
            <Icon name="key" size={27} color={colors.orange} strokeWidth={1.8} />
          </View>
          <Text style={s.title}>{t('vanity.title')}</Text>
        </View>
        <Text style={s.subtitle}>
          Create a custom Monero primary address without giving anyone your recovery words or private keys.
        </Text>

        {latestOrderId ? (
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.75}
            onPress={() => navigation.navigate('VanityOrderStatus', {orderId: latestOrderId})}
            style={s.latestOrderCard}
          >
            <View>
              <Text style={s.latestOrderEyebrow}>LATEST ORDER</Text>
              <Text style={s.latestOrderStatus}>
                {latestOrderLoading
                  ? 'Refreshing status…'
                  : latestOrder
                  ? orderStatusLabel(latestOrder.status)
                  : 'Status unavailable'}
              </Text>
            </View>
            <Icon name="arrow-right" size={20} color={colors.orange} />
          </TouchableOpacity>
        ) : null}

        <View style={s.securityCard}>
          <Icon name="lock" size={20} color={colors.success} />
          <View style={s.securityCopy}>
            <Text style={s.securityTitle}>Your keys stay on this device</Text>
            <Text style={s.securityText}>
              MFW will send only your public primary address. The final address is verified and created locally.
            </Text>
          </View>
        </View>

        <WalletSelector
          activeWalletId={registeredWallet?.id}
          openingWalletId={openingWalletId}
          snapshots={walletSnapshotMap}
          titleKey="walletSelector.wallets"
          wallets={vanityWalletOptions}
          onAdd={() => navigation.navigate('WalletSetup')}
          onManage={() => navigation.navigate('Wallets')}
          onSelect={selectWallet}
        />

        <View style={s.card}>
          <View style={s.prefixListHeader}>
            <Text style={s.label}>Desired prefixes</Text>
            <Text style={s.prefixCount}>
              {prefixFields.length}/{VANITY_MAX_PREFIXES}
            </Text>
          </View>
          {prefixFields.map((field, index) => {
            const duplicate = prefixes.indexOf(field.value) !== index;
            const fieldValid = validPrefix(field.value) && !duplicate;
            return (
              <View key={field.id} style={s.prefixField}>
                <View style={s.prefixFieldHeader}>
                  <Text style={s.prefixFieldLabel}>Prefix {index + 1}</Text>
                  {prefixFields.length > 1 ? (
                    <TouchableOpacity
                      accessibilityLabel={`Remove prefix ${index + 1}`}
                      accessibilityRole="button"
                      activeOpacity={0.7}
                      onPress={() => removePrefix(field.id)}
                    >
                      <Text style={s.removePrefix}>Remove</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                <View style={s.prefixRow}>
                  <TextInput
                    accessibilityLabel={`Desired Monero vanity prefix ${index + 1}`}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={VANITY_MAX_PREFIX_LENGTH}
                    onChangeText={value => updatePrefix(field.id, value)}
                    placeholder="4MFW"
                    placeholderTextColor={colors.textMuted}
                    selectionColor={colors.orange}
                    spellCheck={false}
                    style={s.prefixInput}
                    value={field.value}
                  />
                  <Text style={s.base58}>Base58</Text>
                </View>
                <Text
                  style={[
                    s.fieldHint,
                    !fieldValid && s.fieldHintWarning,
                  ]}
                >
                  {prefixHint(field.value, duplicate)}
                </Text>
              </View>
            );
          })}
          <TouchableOpacity
            accessibilityLabel="Add another vanity prefix"
            accessibilityRole="button"
            activeOpacity={0.72}
            disabled={prefixFields.length >= VANITY_MAX_PREFIXES}
            onPress={addPrefix}
            style={[
              s.addPrefixButton,
              prefixFields.length >= VANITY_MAX_PREFIXES &&
                s.addPrefixButtonDisabled,
            ]}
          >
            <Text style={s.addPrefixIcon}>＋</Text>
            <Text style={s.addPrefixText}>Add another prefix</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.78}
            disabled={!usableWallet || !validPrefixes}
            onPress={continueToPayment}
            style={[
              s.primaryButton,
              (!usableWallet || !validPrefixes) && s.primaryButtonDisabled,
            ]}
          >
            <Icon name="arrow-right" size={20} color={colors.bg} />
            <Text style={s.primaryButtonText}>
              {prefixFields.length === 1 ? 'Find address' : 'Find addresses'}
            </Text>
          </TouchableOpacity>
          {notice ? <Text style={s.notice}>{notice}</Text> : null}
        </View>

        <View style={s.priceCard}>
          <Text style={s.priceEyebrow}>PRIVATE GPU SEARCH</Text>
          <View style={s.priceRow}>
            <Text style={s.price}>Service quote</Text>
            <Text style={s.priceHint}>individual prefix lengths</Text>
          </View>
          <Text style={s.priceText}>The service returns one exact XMR quote for the complete list before payment. A request expires if it is not paid.</Text>
        </View>

        <View style={s.steps}>
          <Text style={s.sectionTitle}>How it works</Text>
          <Step number="1" text="MFW prepares the selected public primary address and your prefix list." />
          <Step number="2" text="After the invoice is confirmed, the GPU worker searches for every requested address." />
          <Step number="3" text="MFW verifies every result locally before it creates and saves the new wallets." />
        </View>

        <Text style={s.scope}>Monero mainnet primary addresses only. Each result is an independent primary wallet, not a subaddress. Ledger wallets are not supported in this first version.</Text>
      </ScrollView>
    </View>
  );
}

function unsupportedWalletOption(wallet: RegisteredWallet): WalletOption {
  const {kind} = wallet;
  return {
    id: wallet.id,
    kind,
    label: walletDisplayName(wallet),
    meta:
      wallet.network !== 'mainnet'
        ? wallet.network
        : kind === 'hardware'
        ? wallet.hardwareDeviceName ?? 'Ledger'
        : 'Fast Wallet',
    detail:
      wallet.network !== 'mainnet'
        ? 'Mainnet only'
        : 'Not available for vanity generation',
    disabled: true,
    disabledReason:
      wallet.network !== 'mainnet'
        ? 'This first version supports mainnet wallets only.'
        : 'This first version supports software wallets only.',
    tone: 'warning',
  };
}

function Step({number, text}: {number: string; text: string}) {
  return (
    <View style={s.step}>
      <View style={s.stepNumber}><Text style={s.stepNumberText}>{number}</Text></View>
      <Text style={s.stepText}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  scroll: {paddingHorizontal: spacing.lg, paddingTop: 18},
  back: {alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, marginBottom: 16},
  backText: {color: colors.textMuted, fontSize: 16, fontWeight: '700'},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: 14},
  heroIcon: {width: 54, height: 54, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: 'rgba(255,102,0,0.12)'},
  title: {flexShrink: 1, color: colors.textPrimary, fontSize: 34, lineHeight: 40, fontWeight: '800', letterSpacing: -0.8},
  subtitle: {color: colors.textMuted, fontSize: 17, lineHeight: 25, marginTop: 12},
  latestOrderCard: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: 16, marginTop: 18},
  latestOrderEyebrow: {color: colors.orange, fontSize: 10, letterSpacing: 1.1, fontWeight: '800'},
  latestOrderStatus: {color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginTop: 5},
  securityCard: {flexDirection: 'row', gap: 13, backgroundColor: 'rgba(0,208,142,0.08)', borderColor: 'rgba(0,208,142,0.24)', borderWidth: 1, borderRadius: radius.lg, padding: 16, marginTop: 26},
  securityCopy: {flex: 1, gap: 4},
  securityTitle: {color: colors.success, fontSize: 15, fontWeight: '800'},
  securityText: {color: colors.textMuted, fontSize: 13, lineHeight: 19},
  card: {backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: 18, marginTop: 18},
  label: {color: colors.textPrimary, fontSize: 14, fontWeight: '800'},
  prefixListHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12},
  prefixCount: {color: colors.textMuted, fontSize: 12},
  prefixField: {marginTop: 10},
  prefixFieldHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7},
  prefixFieldLabel: {color: colors.textMuted, fontSize: 12, fontWeight: '700'},
  removePrefix: {color: colors.orange, fontSize: 12, fontWeight: '700'},
  prefixRow: {flexDirection: 'row', alignItems: 'center', borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, paddingRight: 14},
  prefixInput: {flex: 1, color: colors.textPrimary, fontSize: 23, fontWeight: '700', paddingHorizontal: 15, paddingVertical: 13},
  base58: {color: colors.orange, fontSize: 11, fontWeight: '800', letterSpacing: 0.5},
  fieldHint: {color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 7},
  fieldHintWarning: {color: colors.orange},
  addPrefixButton: {height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 13, borderWidth: 1, borderColor: colors.orange, marginTop: 14},
  addPrefixButtonDisabled: {opacity: 0.4},
  addPrefixIcon: {color: colors.orange, fontSize: 21, fontWeight: '700'},
  addPrefixText: {color: colors.orange, fontSize: 14, fontWeight: '800'},
  priceCard: {backgroundColor: 'rgba(255,102,0,0.09)', borderColor: 'rgba(255,102,0,0.28)', borderWidth: 1, borderRadius: radius.lg, padding: 18, marginTop: 18},
  priceEyebrow: {color: colors.orange, fontSize: 10, letterSpacing: 1.2, fontWeight: '800'},
  priceRow: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 8},
  price: {color: colors.textPrimary, fontSize: 24, fontWeight: '800'},
  priceHint: {color: colors.textMuted, fontSize: 12},
  priceText: {color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 7},
  steps: {marginTop: 26, gap: 14},
  sectionTitle: {color: colors.textPrimary, fontSize: 18, fontWeight: '800', marginBottom: 2},
  step: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  stepNumber: {width: 23, height: 23, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: 'rgba(255,102,0,0.13)', marginTop: 1},
  stepNumberText: {color: colors.orange, fontSize: 12, fontWeight: '800'},
  stepText: {flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 19},
  scope: {color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 24},
  primaryButton: {height: 56, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, borderRadius: 17, backgroundColor: colors.orange, marginTop: 16},
  primaryButtonDisabled: {opacity: 0.46},
  primaryButtonText: {color: colors.bg, fontSize: 16, fontWeight: '800'},
  notice: {color: colors.textMuted, textAlign: 'center', fontSize: 12, lineHeight: 18, marginTop: 12, paddingHorizontal: 16},
});
