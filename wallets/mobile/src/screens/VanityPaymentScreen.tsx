import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Icon} from '../components/Icon';
import {validateVanitySearchDraft} from '../services/VanityRequest';
import {createPaymentLinkSendPreset} from '../services/IncomingPaymentLink';
import {walletDisplayName} from '../services/WalletRegistry';
import {VANITY_SERVICE_ONION_ORIGIN} from '../services/VanityServicePayment';
import {FastWalletPushService} from '../services/FastWalletPushService';
import {
  createVanityQuote,
  type VanityQuote,
} from '../services/VanityServiceClient';
import {useWalletState} from '../services/WalletState';
import {colors, radius, spacing} from '../theme/colors';

function shortAddress(value: string): string {
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-10)}` : value;
}

export default function VanityPaymentScreen({navigation, route}: any) {
  const insets = useSafeAreaInsets();
  const {registeredWallets} = useWalletState();
  const request = useMemo(
    () => validateVanitySearchDraft(route?.params?.vanityRequest),
    [route?.params?.vanityRequest],
  );
  const wallet = useMemo(() => {
    return registeredWallets.find(
      candidate => candidate.id === request?.sourceWalletRegistrationId,
    );
  }, [registeredWallets, request?.sourceWalletRegistrationId]);
  const serviceOriginConfigured = Boolean(VANITY_SERVICE_ONION_ORIGIN.trim());
  const [quote, setQuote] = useState<VanityQuote>();
  const [creatingQuote, setCreatingQuote] = useState(false);
  const [quoteError, setQuoteError] = useState<string>();
  const automaticQuoteStarted = useRef(false);
  const prefixLengths = request?.prefixes.map(prefix => prefix.length) ?? [];
  const shortestPrefix = prefixLengths.length ? Math.min(...prefixLengths) : 0;
  const longestPrefix = prefixLengths.length ? Math.max(...prefixLengths) : 0;
  const containsLimitedSearch = Boolean(
    request?.prefixes.some(prefix => prefix.length === 10),
  );

  async function prepareQuote() {
    if (!request || !wallet || !serviceOriginConfigured || creatingQuote) return;
    setCreatingQuote(true);
    setQuoteError(undefined);
    try {
      const registration = await FastWalletPushService.enableFastWalletNotifications();
      setQuote(await createVanityQuote(request, registration.subscriptionId));
    } catch (reason) {
      setQuoteError(
        reason instanceof Error ? reason.message : 'The Vanity quote could not be created.',
      );
    } finally {
      setCreatingQuote(false);
    }
  }

  useEffect(() => {
    if (
      automaticQuoteStarted.current ||
      !request ||
      !wallet ||
      !serviceOriginConfigured
    ) return;
    automaticQuoteStarted.current = true;
    void prepareQuote();
  }, [request, serviceOriginConfigured, wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  async function continueToPayment() {
    if (!quote) {
      await prepareQuote();
      return;
    }
    const preset = createPaymentLinkSendPreset({
      flowId: `vanity-${quote.order.id}`,
      uri: `monero:${quote.order.payment_address}?tx_amount=${encodeURIComponent(
        quote.order.price_xmr,
      )}&recipient_name=${encodeURIComponent('MFW Vanity service')}`,
      expiresAtMs: quote.order.quote_expires_at * 1000,
    });
    navigation.navigate('Send', {paymentLinkSendPreset: preset});
  }

  return (
    <View style={s.container}>
      <ScrollView
        contentContainerStyle={[s.scroll, {paddingBottom: Math.max(170, insets.bottom + 140)}]}
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity
          accessibilityRole="button"
          activeOpacity={0.7}
          onPress={() => navigation.goBack()}
          style={s.back}
        >
          <Icon name="arrow-left" size={18} color={colors.textMuted} />
          <Text style={s.backText}>Back</Text>
        </TouchableOpacity>

        <View style={s.titleRow}>
          <View style={s.heroIcon}>
            <Icon name="key" size={27} color={colors.orange} strokeWidth={1.8} />
          </View>
          <Text style={s.title}>Find your addresses</Text>
        </View>
        <Text style={s.subtitle}>
          Review the request and the service quote. Your private keys stay on this device.
        </Text>

        <View style={s.requestCard}>
          <View style={s.requestLine}>
            <Text style={s.requestLabel}>DESIRED PREFIXES</Text>
            <Text style={s.requestValue}>{request?.prefixes.length ?? '—'}</Text>
          </View>
          <View style={s.prefixList}>
            {request?.prefixes.map((prefix, index) => (
              <View key={`${index}:${prefix}`} style={s.prefixPill}>
                <Text selectable style={s.prefix}>{prefix}</Text>
              </View>
            )) ?? <Text style={s.unavailable}>Request unavailable</Text>}
          </View>
          <View style={s.divider} />
          <Text style={s.requestLabel}>PAYING WALLET</Text>
          <Text style={s.walletName}>{wallet ? walletDisplayName(wallet) : 'No wallet selected'}</Text>
          <Text selectable style={s.publicAddress}>
            {request ? shortAddress(request.sourcePublicAddress) : '—'}
          </Text>
        </View>

        <View style={s.priceCard}>
          <View>
            <Text style={s.priceLabel}>Final service price</Text>
            <Text style={s.priceHint}>
              {request
                ? `${request.prefixes.length} prefixes · ${shortestPrefix}–${longestPrefix} characters`
                : 'Calculated from every requested prefix'}
            </Text>
          </View>
          {quote ? (
            <Text style={s.price}>{quote.order.price_xmr} XMR</Text>
          ) : quoteError || !serviceOriginConfigured ? (
            <Text style={s.quoteUnavailable}>Quote unavailable</Text>
          ) : (
            <View accessibilityRole="progressbar" style={s.quotePending}>
              <ActivityIndicator color={colors.orange} size="small" />
              <Text style={s.quotePendingText}>Quote pending</Text>
            </View>
          )}
        </View>
        {quote ? (
          <Text selectable style={s.paymentAddress}>{quote.order.payment_address}</Text>
        ) : null}

        <TouchableOpacity
          accessibilityRole="button"
          activeOpacity={0.8}
          disabled={!request || !wallet || !serviceOriginConfigured || creatingQuote}
          onPress={() => void continueToPayment()}
          style={[
            s.primaryButton,
            (!request || !wallet || !serviceOriginConfigured || creatingQuote) &&
              s.primaryButtonDisabled,
          ]}
        >
          <Icon name="arrow-right" size={20} color={colors.bg} />
          <Text style={s.primaryButtonText}>
            {quote
              ? 'Pay XMR'
              : creatingQuote
              ? 'Connecting through Tor…'
              : quoteError
              ? 'Retry through Tor'
              : 'Continue to payment'}
          </Text>
        </TouchableOpacity>
        {quote ? (
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.75}
            onPress={() => navigation.navigate('VanityOrderStatus', {orderId: quote.order.id})}
            style={s.trackButton}
          >
            <Text style={s.trackButtonText}>Track order</Text>
          </TouchableOpacity>
        ) : null}
        <Text style={s.pendingText}>
          {quoteError
            ? quoteError
            : quote
            ? `Order ${quote.order.id}`
            : creatingQuote
            ? 'Connecting privately to the Vanity service through Tor…'
            : !request
            ? 'Return and prepare a valid vanity request.'
            : serviceOriginConfigured
            ? 'Waiting for the private Tor connection.'
            : 'The production Hidden Service address will be added before payment is activated.'}
        </Text>

        {containsLimitedSearch ? (
          <View style={s.limitedCard}>
            <Icon name="info" size={20} color={colors.orange} />
            <View style={s.securityCopy}>
              <Text style={s.limitedTitle}>60-day limited search</Text>
              <Text style={s.securityText}>
                A 10-character match is not guaranteed. The fee pays for up to 60 days of GPU search and is non-refundable once generation starts.
              </Text>
            </View>
          </View>
        ) : null}

        <View style={s.flowCard}>
          <Text style={s.flowTitle}>Quote and payment</Text>
          <View style={s.flowStep}>
            <Text style={s.stepNumber}>1</Text>
            <View style={s.flowCopy}>
              <Text style={s.flowLabel}>Pay the search fee</Text>
              <Text style={s.flowText}>
                The service returns one exact XMR quote for the complete prefix list.
                Up to three equal-length alternatives form one search group at one price.
              </Text>
            </View>
          </View>
          <View style={s.flowLine} />
          <View style={s.flowStep}>
            <Text style={s.stepNumber}>2</Text>
            <View style={s.flowCopy}>
              <Text style={s.flowLabel}>Verify and save locally</Text>
              <Text style={s.flowText}>
                MFW checks every result on this device before it creates the new wallets.
              </Text>
            </View>
          </View>
        </View>

        <View style={s.securityCard}>
          <Icon name="lock" size={20} color={colors.success} />
          <View style={s.securityCopy}>
            <Text style={s.securityTitle}>Only public wallet data is prepared</Text>
            <Text style={s.securityText}>
              The selected wallet’s public primary address contains the public spend and view keys. No private key is included.
            </Text>
          </View>
        </View>

      </ScrollView>
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
  requestCard: {backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: 18, marginTop: 26},
  requestLabel: {color: colors.textMuted, fontSize: 10, letterSpacing: 1.1, fontWeight: '800'},
  requestLine: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
  requestValue: {color: colors.textPrimary, fontSize: 16, fontWeight: '800'},
  prefixList: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12},
  prefixPill: {borderRadius: 10, backgroundColor: colors.orangeMuted, paddingHorizontal: 11, paddingVertical: 7},
  prefix: {color: colors.orange, fontSize: 15, fontWeight: '800'},
  unavailable: {color: colors.textMuted, fontSize: 13},
  divider: {height: 1, backgroundColor: colors.border, marginVertical: 16},
  walletName: {color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginTop: 5},
  publicAddress: {color: colors.textMuted, fontSize: 12, marginTop: 5},
  priceCard: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderRadius: radius.lg, borderColor: 'rgba(255,102,0,0.28)', borderWidth: 1, backgroundColor: 'rgba(255,102,0,0.09)', padding: 18, marginTop: 18},
  priceLabel: {color: colors.textPrimary, fontSize: 14, fontWeight: '800'},
  priceHint: {color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 3},
  price: {color: colors.orange, fontSize: 19, fontWeight: '800'},
  quotePending: {flexDirection: 'row', alignItems: 'center', gap: 8},
  quotePendingText: {color: colors.orange, fontSize: 14, fontWeight: '800'},
  quoteUnavailable: {color: colors.textMuted, fontSize: 14, fontWeight: '800'},
  flowCard: {marginTop: 18, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard, padding: 18},
  flowTitle: {color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginBottom: 15},
  flowStep: {flexDirection: 'row', gap: 12},
  stepNumber: {width: 26, height: 26, borderRadius: 13, textAlign: 'center', textAlignVertical: 'center', lineHeight: 26, color: colors.bg, backgroundColor: colors.orange, fontSize: 13, fontWeight: '800'},
  flowCopy: {flex: 1},
  flowLabel: {color: colors.textPrimary, fontSize: 14, fontWeight: '800'},
  flowText: {color: colors.textMuted, fontSize: 13, lineHeight: 18, marginTop: 3},
  flowLine: {width: 1, height: 16, backgroundColor: colors.border, marginLeft: 12, marginVertical: 4},
  securityCard: {flexDirection: 'row', gap: 13, backgroundColor: 'rgba(0,208,142,0.08)', borderColor: 'rgba(0,208,142,0.24)', borderWidth: 1, borderRadius: radius.lg, padding: 16, marginTop: 18},
  limitedCard: {flexDirection: 'row', gap: 13, backgroundColor: 'rgba(255,102,0,0.08)', borderColor: 'rgba(255,102,0,0.28)', borderWidth: 1, borderRadius: radius.lg, padding: 16, marginTop: 18},
  limitedTitle: {color: colors.orange, fontSize: 15, fontWeight: '800'},
  securityCopy: {flex: 1, gap: 4},
  securityTitle: {color: colors.success, fontSize: 15, fontWeight: '800'},
  securityText: {color: colors.textMuted, fontSize: 13, lineHeight: 19},
  primaryButton: {height: 56, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10, borderRadius: 17, backgroundColor: colors.orange, marginTop: 22},
  primaryButtonDisabled: {opacity: 0.45},
  primaryButtonText: {color: colors.bg, fontSize: 16, fontWeight: '800'},
  pendingText: {color: colors.textMuted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 10},
  paymentAddress: {color: colors.textMuted, fontSize: 10, lineHeight: 16, marginTop: 10},
  trackButton: {height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 15, borderColor: colors.orange, borderWidth: 1, marginTop: 10},
  trackButtonText: {color: colors.orange, fontSize: 15, fontWeight: '800'},
});
