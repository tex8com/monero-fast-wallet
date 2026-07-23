import React, { useCallback, useMemo, useState } from 'react';
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
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Svg, {
  Path,
  Defs,
  LinearGradient as SvgGrad,
  Stop,
  Circle,
} from 'react-native-svg';
import { colors } from '../theme/colors';
import MoneroLogo from '../components/MoneroLogo';
import SyncStatusBar from '../components/SyncStatusBar';
import TransactionRow, {
  transactionRowKey,
} from '../components/TransactionRow';
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
import { type MoneroNewsCategory, useMoneroNews } from '../data/moneroNews';
import { useI18n } from '../i18n';
import type { FastReceiveIdentityRecord } from '../services/FastReceiveRegistry';
import {
  fastWalletSelectorTone,
  fastWalletStatusPresentation,
} from '../services/FastWalletStatus';
import {
  getActiveNodeConnectionSettings,
  loadActiveNodeConnectionSettings,
} from '../services/NodeConnectionSettings';
import type { NodeConnectionMode } from '../services/NodeConnectionSettings';
import { useWalletState } from '../services/WalletState';
import { walletDisplayName } from '../services/WalletRegistry';
import {
  atomicXmrToNumber,
  formatAtomicXmr,
  subtractAtomic,
  toAtomicBigInt,
} from '../services/WalletFormat';
import { walletService } from '../services/WalletService';
import { presentWalletSync } from '../../../../packages/wallet-shared/src/walletSync';

const W = Dimensions.get('window').width;
const CHART_W = W - 40;
const CHART_H = 160;
const FAST_WALLET_STATUS_REFRESH_MS = 30_000;
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
function fastWalletDashboardOption(
  identity: FastReceiveIdentityRecord,
  t: ReturnType<typeof useI18n>['t'],
  tex8Node: boolean,
): WalletOption {
  const status = fastWalletStatusPresentation(identity, tex8Node, t);
  return {
    id: identity.id,
    address: identity.address,
    badge: t('walletSelector.fast'),
    detail: status.label,
    kind: 'fast',
    label: identity.label,
    meta: identity.network,
    tone: fastWalletSelectorTone(status),
  };
}

/* ── Home Screen ─────────────────────────────────────────────────────── */
export default function HomeScreen({ navigation }: any) {
  const [tf, setTf] = useState('24H');
  const [newsCategory, setNewsCategory] = useState<'all' | MoneroNewsCategory>(
    'all',
  );
  const [fastReceiveIdentities, setFastReceiveIdentities] = useState<
    FastReceiveIdentityRecord[]
  >([]);
  const [nodeMode, setNodeMode] = useState<NodeConnectionMode>(
    getActiveNodeConnectionSettings().mode,
  );
  const { dateLocale, t } = useI18n();
  const { price, change24h, loading: priceLoading } = useXmrPrice();
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
  } = useMoneroNews();
  const {
    error,
    registeredWallet,
    registeredWallets,
    session,
    setActiveRegisteredWallet,
    snapshot,
    status,
    syncProgress,
    transactions,
    walletSnapshots,
  } = useWalletState();
  const hasOpenWallet = Boolean(session);
  const lockedAtomic = snapshot
    ? subtractAtomic(snapshot.balanceAtomic, snapshot.unlockedBalanceAtomic)
    : 0n;
  const lockedXmr = formatAtomicXmr(lockedAtomic, {
    maxFractionDigits: 12,
    minFractionDigits: 4,
  });
  const showLocked = lockedAtomic > 0n;
  const selectedFastIdentity =
    registeredWallet?.kind === 'fast'
      ? fastReceiveIdentities.find(
          identity => identity.id === registeredWallet.id,
        )
      : undefined;
  const selectedFastStatus = selectedFastIdentity
    ? fastWalletStatusPresentation(
        selectedFastIdentity,
        nodeMode === 'optimized-grpc',
        t,
      )
    : undefined;
  const selectedFastWallet = registeredWallet?.kind === 'fast';
  const hasSyncError =
    !selectedFastWallet && (status === 'error' || Boolean(error));
  const syncPresentation = presentWalletSync(snapshot);
  const syncColor = selectedFastStatus
    ? selectedFastStatus.tone === 'success'
      ? colors.success
      : selectedFastStatus.tone === 'danger'
      ? colors.error
      : colors.warning
    : hasSyncError
    ? colors.error
    : status === 'open'
    ? colors.success
    : status === 'syncing' || status === 'opening'
    ? colors.warning
    : colors.orange;
  const syncText = selectedFastStatus
    ? selectedFastStatus.label
    : selectedFastWallet
    ? t('fastWallet.status.settingUp')
    : hasSyncError
    ? t('sync.error')
    : status === 'open'
    ? t('status.live')
    : status === 'syncing'
    ? syncPresentation.phase === 'finalizing'
      ? t('sync.finalizing')
      : `${syncProgress ?? 0}%`
    : status === 'opening'
    ? t('action.open')
    : status === 'locked'
    ? t('status.locked')
    : t('status.setup');

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
  const totalBalanceAtomic = registeredWallets.reduce(
    (sum, wallet) =>
      sum + toAtomicBigInt(walletSnapshotMap[wallet.id]?.balanceAtomic),
    0n,
  );
  const totalBalanceXmr = formatAtomicXmr(totalBalanceAtomic, {
    maxFractionDigits: 4,
    minFractionDigits: 2,
  });
  const totalBalanceUsd =
    price > 0 ? xmrToUsd(atomicXmrToNumber(totalBalanceAtomic), price) : '—';
  const visibleNews = useMemo(
    () =>
      newsCategory === 'all'
        ? newsItems
        : newsItems.filter(item => item.category === newsCategory),
    [newsCategory, newsItems],
  );
  const homeWalletOptions = useMemo<WalletSelectorItem[]>(
    () => [
      ...registeredWallets.filter(wallet => wallet.kind !== 'fast'),
      ...fastReceiveIdentities.map(identity =>
        fastWalletDashboardOption(identity, t, nodeMode === 'optimized-grpc'),
      ),
    ],
    [fastReceiveIdentities, nodeMode, registeredWallets, t],
  );
  const openWalletSetup = () =>
    navigation.navigate(
      registeredWallet ? 'WalletSetup' : 'Welcome',
      registeredWallet
        ? { mode: 'open', openRequestId: Date.now() }
        : undefined,
    );
  const openWalletRoute = (screen: string) => {
    if (registeredWallet) {
      navigation.navigate(screen);
      return;
    }

    navigation.navigate('WalletSetup', {
      mode: 'open',
      openRequestId: Date.now(),
    });
  };
  const selectWallet = async (wallet: WalletOption) => {
    const walletId = wallet.id;
    if (walletId === registeredWallet?.id && hasOpenWallet) {
      return;
    }

    let selectedWallet = registeredWallet;
    const changedWallet = walletId !== registeredWallet?.id;
    if (changedWallet) {
      selectedWallet = await setActiveRegisteredWallet(walletId);
    }
    if (
      changedWallet &&
      selectedWallet?.credentialKey &&
      selectedWallet.kind !== 'hardware'
    ) {
      return;
    }
    navigation.navigate('WalletSetup', {
      mode: 'open',
      openRequestId: Date.now(),
    });
  };

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      let refreshInFlight = false;
      const refreshFastWalletStatus = async () => {
        if (refreshInFlight) {
          return;
        }

        refreshInFlight = true;
        try {
          const [identities, settings] = await Promise.all([
            walletService.loadFastReceiveIdentitiesForActiveNode(),
            loadActiveNodeConnectionSettings(),
          ]);
          if (mounted) {
            setFastReceiveIdentities(identities);
            setNodeMode(settings.mode);
          }
        } finally {
          refreshInFlight = false;
        }
      };

      refreshFastWalletStatus().catch(() => undefined);
      const interval = setInterval(
        () => refreshFastWalletStatus().catch(() => undefined),
        FAST_WALLET_STATUS_REFRESH_MS,
      );

      return () => {
        mounted = false;
        clearInterval(interval);
      };
    }, []),
  );

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={s.header}>
          <View style={s.headerL}>
            <MoneroLogo size={26} />
            <Text style={s.headerT}>
              Monero<Text style={s.headerTOrange}>-Wallet</Text>
            </Text>
          </View>
          <View style={[s.syncBadge, { backgroundColor: `${syncColor}1A` }]}>
            <View style={[s.syncDot, { backgroundColor: syncColor }]} />
            <Text style={[s.syncTxt, { color: syncColor }]}>{syncText}</Text>
          </View>
        </View>

        {registeredWallet && !selectedFastWallet ? (
          <View style={s.syncStatusWrap}>
            <SyncStatusBar
              error={error}
              hideWhenSynced
              progress={syncProgress}
              snapshot={snapshot}
              status={status}
              walletName={walletDisplayName(registeredWallet)}
            />
          </View>
        ) : registeredWallet && selectedFastWallet ? (
          <View style={s.syncStatusWrap}>
            <View style={s.fastWalletStatusCard}>
              <View style={s.fastWalletStatusTopRow}>
                <View style={s.fastWalletStatusTitleGroup}>
                  <Text style={s.fastWalletStatusTitle} numberOfLines={1}>
                    {walletDisplayName(registeredWallet)}
                  </Text>
                  <Text style={[s.fastWalletStatusLabel, { color: syncColor }]}>
                    {syncText}
                  </Text>
                </View>
                <View style={[s.syncDot, { backgroundColor: syncColor }]} />
              </View>
              <Text style={s.fastWalletStatusDescription} numberOfLines={2}>
                {selectedFastStatus?.description ??
                  t('fastWallet.status.settingUpDescription')}
              </Text>
            </View>
          </View>
        ) : null}

        {/* Price */}
        <View style={s.priceSection}>
          {priceLoading ? (
            <ActivityIndicator
              color={colors.orange}
              size="large"
              style={{ marginVertical: 12 }}
            />
          ) : (
            <>
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
            <View
              style={{
                height: CHART_H,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
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
              <Text style={s.newsSourceLink}>{t('home.newsSourceLink')} ↗</Text>
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
            <ScrollView
              horizontal
              pagingEnabled
              decelerationRate="fast"
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.newsPages}
            >
              {visibleNews.slice(0, 8).map(item => (
                <TouchableOpacity
                  key={item.id}
                  style={s.newsPage}
                  onPress={() =>
                    Linking.openURL(item.url).catch(() => undefined)
                  }
                  activeOpacity={0.8}
                >
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
                  <Text numberOfLines={2} style={s.newsSummary}>
                    {item.summary}
                  </Text>
                  <Text style={s.newsDate}>
                    {new Intl.DateTimeFormat(dateLocale, {
                      dateStyle: 'medium',
                    }).format(new Date(item.publishedAt))}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {/* Action Buttons */}
        <View style={s.actRow}>
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
          {showLocked && (
            <View style={s.pendRow}>
              <View style={s.pendDot} />
              <Text style={s.pendTxt}>
                {t('home.lockedBalance', { amount: lockedXmr })}
              </Text>
            </View>
          )}
          {!hasOpenWallet ? (
            <TouchableOpacity style={s.balOpenButton} onPress={openWalletSetup}>
              <Text style={s.balOpenButtonText}>
                {registeredWallet
                  ? t('action.openWallet')
                  : t('home.createOrImport')}
              </Text>
            </TouchableOpacity>
          ) : null}
          {error ? (
            <Text style={s.statusError} numberOfLines={2}>
              {error}
            </Text>
          ) : null}
        </View>

        {homeWalletOptions.length > 0 ? (
          <View style={s.walletSelectorWrap}>
            <WalletSelector
              activeWalletId={registeredWallet?.id}
              snapshots={walletSnapshotMap}
              titleKey="home.allWallets"
              wallets={homeWalletOptions}
              onSelect={selectWallet}
            />
          </View>
        ) : null}

        {/* Transactions */}
        <View style={s.secRow}>
          <Text style={s.secTitle}>{t('home.transactions')}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.7}
            onPress={() => navigation.navigate('Transactions')}
          >
            <Text style={s.secLink}>{t('transactions.viewMore')}</Text>
          </TouchableOpacity>
        </View>

        {hasOpenWallet && transactions.length > 0 ? (
          transactions.slice(0, 3).map(transaction => (
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
          ))
        ) : (
          <View style={s.emptyTxCard}>
            <Text style={s.emptyTxTitle}>
              {hasOpenWallet
                ? t('home.noTransactions')
                : t('home.walletNotOpen')}
            </Text>
            <Text style={s.emptyTxText}>
              {hasOpenWallet
                ? t('home.noTransactionsText')
                : t('home.openWalletToLoad')}
            </Text>
          </View>
        )}
        <View style={{ height: 150 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 58,
    marginBottom: 8,
  },
  headerL: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerT: { color: '#FFF', fontSize: 18, fontWeight: '700' },
  headerTOrange: { color: '#F26822' },
  syncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,214,143,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 50,
    gap: 6,
  },
  syncDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  syncTxt: { color: colors.success, fontSize: 12, fontWeight: '600' },
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
  priceBig: {
    color: '#FFF',
    fontSize: 42,
    fontWeight: '800',
    letterSpacing: -1,
  },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 10,
  },
  changeText: { fontSize: 16, fontWeight: '700' },
  changeUsd: { fontSize: 15, fontWeight: '500' },

  chartWrap: { paddingHorizontal: 20, marginBottom: 4 },
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
  newsPages: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  newsPage: {
    width: CHART_W - 32,
    minHeight: 144,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#332B45',
    backgroundColor: 'rgba(255,255,255,0.025)',
    padding: 15,
  },
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
    marginTop: 'auto',
    paddingTop: 10,
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
  statusError: {
    color: colors.error,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
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
});
