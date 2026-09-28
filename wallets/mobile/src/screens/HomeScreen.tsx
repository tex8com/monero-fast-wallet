import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Dimensions,
  Linking,
  ActivityIndicator,
  Image,
} from 'react-native';
import Svg, {
  Path,
  Defs,
  LinearGradient as SvgGrad,
  Stop,
  Circle,
} from 'react-native-svg';
import { colors, radius } from '../theme/colors';
import SyncStatusBar from '../components/SyncStatusBar';
import LedgerSigningModal from '../components/LedgerSigningModal';
import TransactionRow, {
  transactionRowKey,
} from '../components/TransactionRow';
import TransactionLoadMoreButton from '../components/TransactionLoadMoreButton';
import WalletSelector, {
  type WalletOption,
  type WalletSelectorItem,
} from '../components/WalletSelector';
import {
  type ChartPoint,
  useXmrPrice,
  useXmrChart,
  xmrToUsd,
} from '../data/priceService';
import {
  type MoneroNewsCategory,
  type MoneroNewsItem,
  useMoneroNews,
} from '../data/moneroNews';
import MoneroCoinBg from '../components/MoneroCoinBg';
import { useLocalAdvertisement } from '../data/advertisements';
import { v1ReleaseFeatures } from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';
import { useI18n } from '../i18n';
import { useWalletState } from '../services/WalletState';
import { useConnectivityState } from '../services/ConnectivityState';
import {
  type LedgerSigningProgress,
  isLedgerSigningCancelledError,
} from '../services/LedgerSigningFlow';
import {
  ledgerBalanceNeedsVerification,
  walletDisplayName,
} from '../services/WalletRegistry';
import {
  atomicXmrToNumber,
  formatAtomicXmr,
  toAtomicBigInt,
} from '../services/WalletFormat';
import {
  type CommunityV1Advertisement,
  MoneroEnthusiastV1Service,
} from '../services/MoneroEnthusiastV1Service';

const W = Dimensions.get('window').width;
const CHART_W = W - 40;
const CHART_H = 160;
const NEWS_CARD_W = CHART_W - 32;
const NEWS_CARD_GAP = 12;
const TIMEFRAMES = ['24H', '7D', '1M', '1Y', 'Max'];

/* ── SVG Chart ─────────────────────────────────────────────────────── */
function PriceChart({
  points,
  positive,
  dateLocale,
}: {
  points: ChartPoint[];
  positive: boolean;
  dateLocale: string;
}) {
  const [selectedIndex, setSelectedIndex] = useState(points.length - 1);
  const [showTooltip, setShowTooltip] = useState(false);
  if (points.length < 2) return null;
  const prices = points.map(point => point.price);
  const min = Math.min(...prices) * 0.998;
  const max = Math.max(...prices) * 1.002;
  const range = max - min || 1;
  const pad = 2;
  const stepX = (CHART_W - pad * 2) / (points.length - 1);
  const safeSelectedIndex = Math.min(selectedIndex, points.length - 1);
  const selectedPoint = points[safeSelectedIndex];
  const selectedX = pad + safeSelectedIndex * stepX;
  const selectedY =
    pad +
    (CHART_H - pad * 2) -
    ((selectedPoint.price - min) / range) * (CHART_H - pad * 2);
  const tooltipLeft = Math.max(8, Math.min(CHART_W - 146, selectedX - 70));
  const chartTimestamp = new Intl.DateTimeFormat(dateLocale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(selectedPoint.timestamp));
  const updateSelection = (locationX: number) => {
    const ratio = Math.max(0, Math.min(1, locationX / CHART_W));
    setSelectedIndex(Math.round(ratio * (points.length - 1)));
    setShowTooltip(true);
  };

  let linePath = '';
  let areaPath = '';
  points.forEach((p, i) => {
    const x = pad + i * stepX;
    const y =
      pad +
      (CHART_H - pad * 2) -
      ((p.price - min) / range) * (CHART_H - pad * 2);
    if (i === 0) {
      linePath += `M${x},${y}`;
      areaPath += `M${x},${CHART_H}L${x},${y}`;
    } else {
      const px = pad + (i - 1) * stepX;
      const py =
        pad +
        (CHART_H - pad * 2) -
        ((points[i - 1].price - min) / range) * (CHART_H - pad * 2);
      linePath += `C${px + stepX * 0.4},${py} ${
        x - stepX * 0.4
      },${y} ${x},${y}`;
      areaPath += `C${px + stepX * 0.4},${py} ${
        x - stepX * 0.4
      },${y} ${x},${y}`;
    }
  });
  areaPath += `L${pad + (points.length - 1) * stepX},${CHART_H}Z`;
  const lc = positive ? '#00D68F' : '#FF4466';
  const gid = positive ? 'gG' : 'gR';

  const lastPoint = points[points.length - 1];
  const lastY =
    pad +
    (CHART_H - pad * 2) -
    ((lastPoint.price - min) / range) * (CHART_H - pad * 2);

  return (
    <View
      style={s.chartInteractive}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={event => updateSelection(event.nativeEvent.locationX)}
      onResponderMove={event => updateSelection(event.nativeEvent.locationX)}
    >
      <Svg width={CHART_W} height={CHART_H} pointerEvents="none">
        <Defs>
          <SvgGrad id={gid} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={lc} stopOpacity="0.2" />
            <Stop offset="1" stopColor={lc} stopOpacity="0" />
          </SvgGrad>
        </Defs>
        <Path d={areaPath} fill={`url(#${gid})`} />
        <Path d={linePath} stroke={lc} strokeWidth={2} fill="none" />
        {showTooltip && (
          <Path
            d={`M${selectedX},0L${selectedX},${CHART_H}`}
            stroke="rgba(255,255,255,0.38)"
            strokeWidth={1}
          />
        )}
        <Circle
          cx={showTooltip ? selectedX : pad + (points.length - 1) * stepX}
          cy={showTooltip ? selectedY : lastY}
          r={showTooltip ? 5 : 4}
          fill={lc}
        />
      </Svg>
      {showTooltip && (
        <View
          pointerEvents="none"
          style={[s.chartTooltip, { left: tooltipLeft }]}
        >
          <Text style={s.chartTooltipPrice}>
            ${selectedPoint.price.toFixed(2)}
          </Text>
          <Text style={s.chartTooltipDate}>{chartTimestamp}</Text>
        </View>
      )}
    </View>
  );
}

/* ── Action Button Icons ───────────────────────────────────────────── */
function IcoUp({ c }: { c: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 19V5M5 12l7-7 7 7"
        stroke={c}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
function IcoDown({ c }: { c: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 5v14M5 12l7 7 7-7"
        stroke={c}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function AdvertisementCard({
  advertisement,
}: {
  advertisement: CommunityV1Advertisement;
}) {
  const { t } = useI18n();
  const [showReason, setShowReason] = useState(false);
  const recordedCampaigns = useRef(new Set<string>());

  useEffect(() => {
    if (recordedCampaigns.current.has(advertisement.campaignId)) return;
    recordedCampaigns.current.add(advertisement.campaignId);
    MoneroEnthusiastV1Service.recordAdvertisementView(
      advertisement.campaignId,
    ).catch(() => undefined);
  }, [advertisement.campaignId]);

  return (
    <View style={s.adCard}>
      <View style={s.adHeader}>
        <Text style={s.adLabel}>
          {advertisement.sponsorshipLabel === 'sponsored'
            ? t('advertising.sponsored')
            : t('advertising.advertisement')}
        </Text>
        <Text style={s.advertiser}>
          {t('advertising.paidBy', {
            advertiser: advertisement.paidByDisplayName,
          })}
        </Text>
      </View>
      <Text style={s.adTitle}>{advertisement.title}</Text>
      <Text style={s.adBody}>{advertisement.body}</Text>
      <View style={s.adActions}>
        <TouchableOpacity
          accessibilityRole="link"
          style={s.adOpenButton}
          onPress={() =>
            Linking.openURL(advertisement.destinationUrl).catch(() => undefined)
          }
        >
          <Text style={s.adOpenText}>{t('advertising.learnMore')} ↗</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => setShowReason(value => !value)}
        >
          <Text style={s.adWhy}>{t('advertising.why')}</Text>
        </TouchableOpacity>
      </View>
      {showReason ? (
        <Text style={s.adReason}>
          {advertisement.selectionReason === 'local_interests'
            ? t('advertising.reasonLocal')
            : t('advertising.reasonContextual')}
        </Text>
      ) : null}
    </View>
  );
}

/* ── Home Screen ─────────────────────────────────────────────────────── */
function NewsCatalogImage({ item }: { item: MoneroNewsItem }) {
  const [failed, setFailed] = useState(false);
  if (!item.imageUrl || failed) {
    return (
      <View style={s.newsImageFallback}>
        <MoneroCoinBg size={92} />
      </View>
    );
  }
  return (
    <Image
      accessibilityLabel={item.title}
      onError={() => setFailed(true)}
      resizeMode="cover"
      source={{ uri: item.imageUrl }}
      style={s.newsImage}
    />
  );
}

export default function HomeScreen({ navigation }: any) {
  const [tf, setTf] = useState('24H');
  const [syncStatusExpanded, setSyncStatusExpanded] = useState(true);
  const [openingWalletId, setOpeningWalletId] = useState<string | undefined>();
  const [ledgerPreparationError, setLedgerPreparationError] = useState<
    string | undefined
  >();
  const [ledgerSigningProgress, setLedgerSigningProgress] = useState<
    LedgerSigningProgress | undefined
  >();
  const ledgerSigningCancelledRef = useRef(false);
  const [newsCategory, setNewsCategory] = useState<'all' | MoneroNewsCategory>(
    'all',
  );
  const [newsSlideIndex, setNewsSlideIndex] = useState(0);
  const newsSliderRef = useRef<ScrollView>(null);
  const { dateLocale, t } = useI18n();
  const connectivity = useConnectivityState();
  const {
    price,
    change24h,
    loading: priceLoading,
    error: priceError,
    refresh: refreshPrice,
  } = useXmrPrice();
  const {
    points,
    loading: chartLoading,
    error: chartError,
    refresh: refreshChart,
  } = useXmrChart(tf);
  const {
    items: newsItems,
    loading: newsLoading,
    unavailable: newsUnavailable,
    refresh: refreshNews,
  } = useMoneroNews(v1ReleaseFeatures.news);
  const advertisement = useLocalAdvertisement(
    v1ReleaseFeatures.moneroEnthusiastV1 && v1ReleaseFeatures.news,
  );
  const {
    connectLedgerForSigning,
    registeredWallet,
    registeredWallets,
    isRegisteredWalletOpen,
    networkSyncStatus,
    openRegisteredWalletById,
    restoreLedgerViewAfterSigning,
    session,
    setActiveRegisteredWallet,
    snapshot,
    spendReady,
    workingSnapshot,
    walletReadinessPhase,
    status,
    syncProgress,
    syncStartHeight,
    transactions,
    walletSnapshots,
  } = useWalletState();
  const hasOpenWallet = Boolean(session);
  const positive =
    tf === '24H'
      ? change24h >= 0
      : points.length >= 2
      ? points[points.length - 1].price >= points[0].price
      : true;

  const changePercent =
    tf === '24H'
      ? change24h
      : points.length >= 2
      ? ((points[points.length - 1].price - points[0].price) /
          points[0].price) *
        100
      : 0;

  const changeUsd = price > 0 ? Math.abs((changePercent / 100) * price) : 0;
  const walletSnapshotMap = useMemo(
    () => ({
      ...walletSnapshots,
      ...(registeredWallet && snapshot
        ? { [registeredWallet.id]: snapshot }
        : {}),
    }),
    [registeredWallet, snapshot, walletSnapshots],
  );
  // The dashboard represents the selected wallet, never a sum of every local
  // registration. A Ledger Fast Wallet can share a source wallet with its
  // parent, and old local registrations may refer to the same account; adding
  // those snapshots would display the same funds more than once.
  const activeWalletSnapshot = registeredWallet
    ? walletSnapshotMap[registeredWallet.id]
    : snapshot;
  const activeLedgerNeedsVerification = Boolean(
    registeredWallet &&
      ledgerBalanceNeedsVerification(
        registeredWallet,
        activeWalletSnapshot?.pendingOutputKeyImageCount,
        transactions.length,
      ),
  );

  const totalBalanceAtomic = toAtomicBigInt(
    activeWalletSnapshot?.balanceAtomic,
  );
  const totalUnlockedAtomic = activeLedgerNeedsVerification
    ? 0n
    : toAtomicBigInt(activeWalletSnapshot?.unlockedBalanceAtomic);
  const lockedAtomic = totalBalanceAtomic - totalUnlockedAtomic;
  const lockedXmr = formatAtomicXmr(lockedAtomic, {
    maxFractionDigits: 12,
    minFractionDigits: 4,
  });
  const showLocked = lockedAtomic > 0n;
  const hasUnverifiedLedgerBalance = activeLedgerNeedsVerification;
  // A view wallet sees received outputs before Ledger-derived key images tell
  // it which ones were spent. Showing that intermediate sum as real balance
  // is financially misleading, so hide it until reconciliation completes.
  const totalBalanceXmr = hasUnverifiedLedgerBalance
    ? '—'
    : formatAtomicXmr(totalBalanceAtomic, {
        maxFractionDigits: 4,
        minFractionDigits: 2,
      });
  const totalBalanceUsd =
    !hasUnverifiedLedgerBalance && price > 0
      ? xmrToUsd(atomicXmrToNumber(totalBalanceAtomic), price)
      : '—';
  const visibleNews = useMemo(
    () =>
      newsCategory === 'all'
        ? newsItems
        : newsItems.filter(item => item.category === newsCategory),
    [newsCategory, newsItems],
  );
  const displayedNews = visibleNews.slice(0, 10);
  useEffect(() => {
    setNewsSlideIndex(0);
    newsSliderRef.current?.scrollTo({ x: 0, animated: true });
  }, [newsCategory]);
  const homeWalletOptions = useMemo<WalletSelectorItem[]>(
    () => registeredWallets,
    [registeredWallets],
  );
  const openWalletSetup = () => navigation.navigate('Welcome');
  const openWalletRoute = (screen: string) => {
    if (registeredWallet) {
      navigation.navigate(screen);
      return;
    }

    navigation.navigate('Welcome');
  };
  const selectWallet = (wallet: WalletOption) => {
    const walletId = wallet.id;
    if (isRegisteredWalletOpen(walletId)) {
      if (walletId !== registeredWallet?.id) {
        // The state provider commits the active cached snapshot before its
        // background registry write. Do not manufacture a loading phase.
        setActiveRegisteredWallet(walletId).catch(() => undefined);
      }
      return;
    }

    if (wallet.kind !== 'hardware') {
      // Software and Fast Wallet selection is optimistic: the cached snapshot
      // changes in this JavaScript turn while an uncommon cold local-file open
      // completes in the native worker. Sync is always deferred.
      openRegisteredWalletById(walletId)
        .then(() => undefined)
        .catch(() => undefined);
      return;
    }

    if (openingWalletId) return;
    setOpeningWalletId(walletId);
    openRegisteredWalletById(walletId)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => setOpeningWalletId(undefined));
  };

  useEffect(
    () => () => {
      ledgerSigningCancelledRef.current = true;
    },
    [],
  );

  const prepareLedgerForSending = async () => {
    if (
      ledgerSigningProgress ||
      registeredWallet?.kind !== 'hardware' ||
      !session
    ) {
      return;
    }

    ledgerSigningCancelledRef.current = false;
    setLedgerPreparationError(undefined);
    setLedgerSigningProgress({ phase: 'searching' });
    try {
      const signingSession = await connectLedgerForSigning({
        isCancelled: () => ledgerSigningCancelledRef.current,
        onProgress: progress => {
          if (!ledgerSigningCancelledRef.current) {
            setLedgerSigningProgress(progress);
          }
        },
      });
      if (!signingSession || signingSession.readOnly) {
        throw new Error(t('sync.ledgerSigningPreparationRequired'));
      }
      await restoreLedgerViewAfterSigning();
    } catch (reason) {
      if (!isLedgerSigningCancelledError(reason)) {
        setLedgerPreparationError(
          reason instanceof Error ? reason.message : String(reason),
        );
      }
    } finally {
      setLedgerSigningProgress(undefined);
    }
  };

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        {registeredWallet ? (
          <View style={s.syncStatusWrap}>
            <SyncStatusBar
              expanded={syncStatusExpanded}
              onExpandedChange={setSyncStatusExpanded}
              progress={syncProgress}
              networkStatus={networkSyncStatus}
              readinessPhase={walletReadinessPhase}
              onPrepareLedger={
                registeredWallet.kind === 'hardware'
                  ? () => {
                      prepareLedgerForSending().catch(() => undefined);
                    }
                  : undefined
              }
              prepareLedgerError={ledgerPreparationError}
              snapshot={workingSnapshot}
              spendReady={spendReady}
              syncStartHeight={syncStartHeight}
              status={status}
              torStatus={connectivity.tor}
              walletName={walletDisplayName(registeredWallet)}
            />
          </View>
        ) : null}

        {/* Price */}
        <View style={s.priceSection}>
          {priceLoading ? (
            <ActivityIndicator
              color={colors.orange}
              size="large"
              style={s.priceLoadingIndicator}
            />
          ) : priceError || price <= 0 ? (
            <View style={s.priceUnavailable}>
              <Text style={s.priceUnavailableText}>
                {t('home.priceUnavailable')}
              </Text>
              <TouchableOpacity
                style={s.chartRetryButton}
                onPress={refreshPrice}
              >
                <Text style={s.chartRetryText}>{t('action.retry')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={s.priceLabel}>{t('home.marketPrice')}</Text>
              <Text style={s.priceBig}>
                $
                {price.toLocaleString(dateLocale, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </Text>
              <View style={s.changeRow}>
                <Text
                  style={[
                    s.changeText,
                    { color: positive ? colors.textGreen : colors.textRed },
                  ]}
                >
                  {positive ? '▲' : '▼'} {Math.abs(changePercent).toFixed(2)}%
                </Text>
                <Text
                  style={[
                    s.changeUsd,
                    { color: positive ? colors.textGreen : colors.textRed },
                  ]}
                >
                  {positive ? '+' : '-'}${changeUsd.toFixed(2)}
                </Text>
              </View>
            </>
          )}
        </View>

        {/* Chart */}
        <View style={s.chartWrap}>
          {chartLoading && points.length < 2 ? (
            <View style={s.chartLoading}>
              <ActivityIndicator color={colors.orange} />
            </View>
          ) : points.length >= 2 ? (
            <PriceChart
              points={points}
              positive={positive}
              dateLocale={dateLocale}
            />
          ) : (
            <View style={s.chartUnavailable}>
              <Text style={s.chartUnavailableText}>
                {chartError
                  ? t('home.chartUnavailable')
                  : t('home.chartLoading')}
              </Text>
              <TouchableOpacity
                style={s.chartRetryButton}
                onPress={refreshChart}
              >
                <Text style={s.chartRetryText}>{t('action.retry')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Timeframe Selector */}
        <View style={s.tfRow}>
          {TIMEFRAMES.map(frame => (
            <TouchableOpacity
              key={frame}
              style={[s.tfBtn, tf === frame && s.tfBtnActive]}
              onPress={() => setTf(frame)}
            >
              <Text style={[s.tfText, tf === frame && s.tfTextActive]}>
                {frame}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Balance Card */}
        <View style={s.balCard}>
          <Text style={s.balLabel}>{t('home.totalBalance')}</Text>
          <View style={s.balRow}>
            <Text style={s.balXmr}>
              {registeredWallets.length > 0
                ? `${totalBalanceXmr} XMR`
                : t('home.noWallet')}
            </Text>
            <Text style={s.balUsd}>
              {registeredWallets.length > 0 ? `$${totalBalanceUsd}` : ''}
            </Text>
          </View>
          {showLocked && !hasUnverifiedLedgerBalance && (
            <View style={s.pendRow}>
              <View style={s.pendDot} />
              <Text style={s.pendTxt}>
                {t('home.lockedBalance', { amount: lockedXmr })}
              </Text>
            </View>
          )}
          {registeredWallets.length === 0 ? (
            <TouchableOpacity style={s.balOpenButton} onPress={openWalletSetup}>
              <Text style={s.balOpenButtonText}>
                {t('home.createOrImport')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {v1ReleaseFeatures.news ? (
          <View style={s.newsCard}>
            <View style={s.newsHeader}>
              <View>
                <Text style={s.newsEyebrow}>{t('home.newsSource')}</Text>
                <Text style={s.newsTitle}>{t('home.newsTitle')}</Text>
              </View>
              <TouchableOpacity
                onPress={() =>
                  Linking.openURL('https://www.getmonero.org/blog/').catch(
                    () => undefined,
                  )
                }
              >
                <Text style={s.newsSourceLink}>
                  {t('home.newsSourceLink')} ↗
                </Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.newsFilters}
            >
              {(['all', 'network', 'wallet', 'ecosystem'] as const).map(
                category => (
                  <TouchableOpacity
                    key={category}
                    style={[
                      s.newsFilter,
                      newsCategory === category && s.newsFilterActive,
                    ]}
                    onPress={() => setNewsCategory(category)}
                  >
                    <Text
                      style={[
                        s.newsFilterText,
                        newsCategory === category && s.newsFilterTextActive,
                      ]}
                    >
                      {category === 'all'
                        ? t('home.newsAll')
                        : category === 'network'
                        ? t('home.newsNetwork')
                        : category === 'wallet'
                        ? t('home.newsWallet')
                        : t('home.newsEcosystem')}
                    </Text>
                  </TouchableOpacity>
                ),
              )}
            </ScrollView>
            {newsLoading && newsItems.length === 0 ? (
              <Text style={s.newsStatus}>{t('home.newsLoading')}</Text>
            ) : newsUnavailable && newsItems.length === 0 ? (
              <View style={s.newsUnavailable}>
                <Text style={s.newsStatus}>{t('home.newsUnavailable')}</Text>
                <TouchableOpacity onPress={refreshNews}>
                  <Text style={s.newsRetry}>{t('action.retry')}</Text>
                </TouchableOpacity>
              </View>
            ) : visibleNews.length === 0 ? (
              <Text style={s.newsStatus}>{t('home.newsEmpty')}</Text>
            ) : (
              <>
                <ScrollView
                  horizontal
                  decelerationRate="fast"
                  snapToInterval={NEWS_CARD_W + NEWS_CARD_GAP}
                  snapToAlignment="start"
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.newsPages}
                  ref={newsSliderRef}
                  onMomentumScrollEnd={event => {
                    const index = Math.round(
                      event.nativeEvent.contentOffset.x /
                        (NEWS_CARD_W + NEWS_CARD_GAP),
                    );
                    setNewsSlideIndex(
                      Math.max(0, Math.min(index, displayedNews.length - 1)),
                    );
                  }}
                >
                  {displayedNews.map(item => (
                    <View key={item.id} style={s.newsPage}>
                      <View style={s.newsImageFrame}>
                        <NewsCatalogImage item={item} />
                      </View>
                      <View style={s.newsPageBody}>
                        <Text style={s.newsCategory}>
                          {item.category === 'network'
                            ? t('home.newsNetwork')
                            : item.category === 'wallet'
                            ? t('home.newsWallet')
                            : t('home.newsEcosystem')}
                        </Text>
                        <Text numberOfLines={2} style={s.newsItemTitle}>
                          {item.title}
                        </Text>
                        <Text numberOfLines={3} style={s.newsSummary}>
                          {item.summary}
                        </Text>
                        <View style={s.newsFooter}>
                          <Text style={s.newsDate}>
                            {new Intl.DateTimeFormat(dateLocale, {
                              dateStyle: 'medium',
                            }).format(new Date(item.publishedAt))}
                          </Text>
                          {item.url ? (
                            <TouchableOpacity
                              accessibilityRole="link"
                              onPress={() =>
                                Linking.openURL(item.url!).catch(
                                  () => undefined,
                                )
                              }
                              style={s.newsOpenButton}
                            >
                              <Text style={s.newsOpenButtonText}>
                                {t('home.newsReadMore')} ↗
                              </Text>
                            </TouchableOpacity>
                          ) : null}
                        </View>
                      </View>
                    </View>
                  ))}
                </ScrollView>
                <View style={s.newsDots}>
                  {displayedNews.map((item, index) => (
                    <View
                      key={`news-dot-${item.id}`}
                      style={[
                        s.newsDot,
                        index === newsSlideIndex && s.newsDotActive,
                      ]}
                    />
                  ))}
                </View>
              </>
            )}
          </View>
        ) : null}

        {advertisement ? (
          <AdvertisementCard advertisement={advertisement} />
        ) : null}

        {/* Action Buttons */}
        <View style={s.actRow}>
          <TouchableOpacity
            style={s.actBtn}
            onPress={() => openWalletRoute('Receive')}
            activeOpacity={0.7}
          >
            <View style={s.actCircle}>
              <IcoDown c="#FFF" />
            </View>
            <Text style={s.actLabel}>{t('tabs.receive')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.actBtn}
            onPress={() => openWalletRoute('Send')}
            activeOpacity={0.7}
          >
            <View style={s.actCircle}>
              <IcoUp c="#FFF" />
            </View>
            <Text style={s.actLabel}>{t('tabs.send')}</Text>
          </TouchableOpacity>
        </View>

        {homeWalletOptions.length > 0 ? (
          <View style={s.walletSelectorWrap}>
            <WalletSelector
              activeWalletId={registeredWallet?.id}
              openingWalletId={openingWalletId}
              snapshots={walletSnapshotMap}
              titleKey="home.allWallets"
              wallets={homeWalletOptions}
              onSelect={selectWallet}
              onAdd={() => navigation.navigate('WalletSetup')}
              onManage={() => navigation.navigate('Wallets')}
            />
          </View>
        ) : null}

        {/* Transactions */}
        <View style={s.secRow}>
          <Text style={s.secTitle}>{t('home.transactions')}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.7}
            onPress={() =>
              navigation.navigate('Transactions', { addressFilter: null })
            }
          >
            <Text style={s.secLink}>{t('transactions.viewMore')}</Text>
          </TouchableOpacity>
        </View>

        {hasOpenWallet && transactions.length > 0 ? (
          <>
            {transactions.slice(0, 3).map(transaction => (
              <TransactionRow
                key={transactionRowKey(transaction)}
                style={s.transactionRow}
                transaction={transaction}
                onPress={() =>
                  navigation.navigate('TransactionDetail', {
                    transaction,
                    transactionHash: transaction.hash,
                    walletId: registeredWallet?.id,
                    walletName: registeredWallet
                      ? walletDisplayName(registeredWallet)
                      : undefined,
                  })
                }
              />
            ))}
            <TransactionLoadMoreButton
              onPress={() =>
                navigation.navigate('Transactions', { addressFilter: null })
              }
            />
          </>
        ) : (
          <View style={s.emptyTxCard}>
            <Text style={s.emptyTxTitle}>
              {hasOpenWallet
                ? t('home.noTransactions')
                : registeredWallet
                ? t('sync.opening')
                : t('home.walletNotOpen')}
            </Text>
            <Text style={s.emptyTxText}>
              {hasOpenWallet
                ? t('home.noTransactionsText')
                : registeredWallet
                ? t('sync.waitingForStatus')
                : t('home.openWalletToLoad')}
            </Text>
          </View>
        )}
        <View style={s.bottomSpacer} />
      </ScrollView>
      <LedgerSigningModal
        progress={ledgerSigningProgress}
        onCancel={() => {
          ledgerSigningCancelledRef.current = true;
          setLedgerSigningProgress(undefined);
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingTop: 12 },
  syncStatusWrap: { paddingHorizontal: 20 },
  fastWalletStatusCard: {
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.045)',
    padding: 14,
    marginBottom: 14,
  },
  fastWalletStatusTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  fastWalletStatusTitleGroup: { flex: 1 },
  fastWalletStatusTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  fastWalletStatusLabel: {
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
  fastWalletStatusDescription: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
  },

  priceSection: { paddingHorizontal: 20, marginBottom: 8 },
  priceLoadingIndicator: { marginVertical: 12 },
  priceUnavailable: {
    minHeight: 70,
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 8,
  },
  priceUnavailableText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  priceBig: {
    color: '#FFF',
    fontSize: 42,
    fontWeight: '800',
    letterSpacing: -1,
  },
  priceLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 10,
  },
  changeText: { fontSize: 16, fontWeight: '700' },
  changeUsd: { fontSize: 15, fontWeight: '500' },

  chartWrap: {
    borderRadius: radius.md,
    elevation: 4,
    marginBottom: 4,
    paddingHorizontal: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 14,
  },
  chartLoading: {
    height: CHART_H,
    justifyContent: 'center',
    alignItems: 'center',
  },
  chartInteractive: { height: CHART_H, position: 'relative' },
  chartTooltip: {
    position: 'absolute',
    top: 8,
    width: 138,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4B405B',
    backgroundColor: 'rgba(17,14,27,0.95)',
  },
  chartTooltipPrice: { color: '#FFF', fontSize: 13, fontWeight: '800' },
  chartTooltipDate: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  chartUnavailable: {
    height: CHART_H,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  chartUnavailableText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  chartRetryButton: {
    backgroundColor: 'rgba(242,104,34,0.16)',
    borderColor: colors.orange,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  chartRetryText: { color: colors.orange, fontSize: 12, fontWeight: '800' },

  tfRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    marginBottom: 24,
    gap: 6,
  },
  tfBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  tfBtnActive: { backgroundColor: colors.orange },
  tfText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  tfTextActive: { color: '#FFF' },

  newsCard: {
    marginHorizontal: 20,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#332B45',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.bgCard,
  },
  newsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 15,
  },
  newsEyebrow: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  newsTitle: { color: '#FFF', fontSize: 17, fontWeight: '800', marginTop: 3 },
  newsSourceLink: { color: '#F4A369', fontSize: 12, fontWeight: '800' },
  newsFilters: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
  },
  newsFilter: {
    borderColor: '#3B324E',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  newsFilterActive: {
    backgroundColor: colors.orange,
    borderColor: colors.orange,
  },
  newsFilterText: { color: colors.textMuted, fontSize: 11, fontWeight: '800' },
  newsFilterTextActive: { color: '#FFF' },
  newsStatus: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  newsUnavailable: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  newsRetry: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
    paddingRight: 16,
    paddingBottom: 16,
  },
  newsPages: { paddingHorizontal: 16, gap: NEWS_CARD_GAP },
  newsPage: {
    width: NEWS_CARD_W,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#332B45',
    backgroundColor: 'rgba(255,255,255,0.025)',
    overflow: 'hidden',
  },
  newsImageFrame: {
    aspectRatio: 16 / 9,
    backgroundColor: '#171321',
    overflow: 'hidden',
    width: '100%',
  },
  newsImage: { height: '100%', width: '100%' },
  newsImageFallback: {
    alignItems: 'center',
    backgroundColor: '#1C1426',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  newsPageBody: { minHeight: 184, padding: 15 },
  newsCategory: {
    color: '#F4BD55',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  newsItemTitle: {
    color: '#EEE8F2',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 21,
    marginTop: 8,
  },
  newsSummary: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
  newsDate: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  newsFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 'auto',
    paddingTop: 14,
  },
  newsOpenButton: {
    backgroundColor: 'rgba(242,104,34,0.14)',
    borderColor: 'rgba(242,104,34,0.42)',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  newsOpenButtonText: {
    color: '#F4A369',
    fontSize: 11,
    fontWeight: '800',
  },
  newsDots: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    paddingBottom: 15,
    paddingTop: 12,
  },
  newsDot: {
    backgroundColor: '#42384F',
    borderRadius: 999,
    height: 6,
    width: 6,
  },
  newsDotActive: { backgroundColor: colors.orange, width: 18 },
  adCard: {
    marginHorizontal: 20,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: `${colors.orange}66`,
    borderRadius: 16,
    backgroundColor: colors.orangeMuted,
    padding: 16,
  },
  adHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  adLabel: {
    color: colors.orange,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  advertiser: {
    color: colors.textMuted,
    flex: 1,
    fontSize: 10,
    textAlign: 'right',
  },
  adTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 21,
    marginTop: 10,
  },
  adBody: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
  adActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
  },
  adOpenButton: {
    borderRadius: 9,
    backgroundColor: colors.orange,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  adOpenText: { color: '#FFF', fontSize: 12, fontWeight: '800' },
  adWhy: { color: colors.textSecondary, fontSize: 11, fontWeight: '700' },
  adReason: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 11,
  },

  actRow: { flexDirection: 'row', paddingHorizontal: 20, marginBottom: 24 },
  actBtn: { flex: 1, alignItems: 'center' },
  actCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 10,
  },
  balCard: {
    marginHorizontal: 20,
    backgroundColor: colors.bgCard,
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  balLabel: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  balRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  balXmr: { color: '#FFF', fontSize: 26, fontWeight: '800' },
  balUsd: { color: colors.textSecondary, fontSize: 16, fontWeight: '500' },
  pendRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  pendDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.warning,
    marginRight: 6,
  },
  pendTxt: { color: colors.warning, fontSize: 12, fontWeight: '500' },
  balOpenButton: {
    alignSelf: 'flex-start',
    marginTop: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.orange,
  },
  balOpenButtonText: { color: '#FFF', fontSize: 13, fontWeight: '800' },
  ledgerVerificationPanel: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${colors.warning}66`,
    backgroundColor: `${colors.warning}12`,
    gap: 6,
  },
  ledgerVerificationTitle: {
    color: colors.warning,
    fontSize: 13,
    fontWeight: '800',
  },
  ledgerVerificationHint: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  ledgerVerificationButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.orange,
  },
  ledgerVerificationButtonBusy: { opacity: 0.65 },
  ledgerVerificationButtonText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '800',
  },
  walletSelectorWrap: { paddingHorizontal: 20 },

  secRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingHorizontal: 20,
  },
  secTitle: { color: '#FFF', fontSize: 17, fontWeight: '700' },
  secLink: { color: colors.orange, fontSize: 13, fontWeight: '600' },
  transactionRow: { marginHorizontal: 20 },
  txCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 8,
    marginHorizontal: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  txDot: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  txDotIn: { backgroundColor: 'rgba(0,214,143,0.12)' },
  txDotOut: { backgroundColor: 'rgba(255,68,102,0.12)' },
  txMid: { flex: 1, marginRight: 8 },
  txType: { color: '#FFF', fontSize: 14, fontWeight: '600' },
  txMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  txRight: { alignItems: 'flex-end' },
  txXmr: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  txXmrIn: { color: colors.success },
  txFiat: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  emptyTxCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 16,
    marginHorizontal: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTxTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 4,
  },
  emptyTxText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  bottomSpacer: { height: 150 },
});
