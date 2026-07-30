import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  ActivityIndicator,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MoneroCoinGhost from '../components/MoneroCoinGhost';
import MoneroCoin from '../components/MoneroCoin';
import { useI18n } from '../i18n';
import { useWalletState } from '../services/WalletState';
import {
  isFastWalletRegistration,
  walletDisplayName,
} from '../services/WalletRegistry';
import { saveFastWalletPreference } from '../services/FastWalletPreference';
import {
  loadCommunityQueryContributionState,
  setCommunityQueryContributionEnabled,
} from '../services/CommunityQueryContribution';

const IS_TEST = typeof jest !== 'undefined';

export default function WelcomeScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const {
    isRegisteredWalletOpen,
    registeredWallets,
    setActiveRegisteredWallet,
  } = useWalletState();
  const [openingWalletId, setOpeningWalletId] = useState<string | undefined>();
  const [shareCommunitySearches, setShareCommunitySearches] = useState(true);
  const contentOp = useRef(new Animated.Value(IS_TEST ? 1 : 0)).current;
  const contentY = useRef(new Animated.Value(IS_TEST ? 0 : 10)).current;

  useEffect(() => {
    if (IS_TEST) {
      return;
    }

    Animated.parallel([
      Animated.timing(contentOp, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(contentY, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
  }, [contentOp, contentY]);

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

  const updateSearchSharing = useCallback((enabled: boolean) => {
    setShareCommunitySearches(enabled);
    setCommunityQueryContributionEnabled(enabled).catch(() => {
      setShareCommunitySearches(!enabled);
    });
  }, []);

  const continueToSetup = useCallback(async () => {
    await saveFastWalletPreference('disabled');
    navigation.navigate('WalletSetup', {
      fastWalletEnabled: false,
    });
  }, [navigation]);

  const openSavedWallet = useCallback(
    async (walletId: string) => {
      if (openingWalletId) return;
      setOpeningWalletId(walletId);
      try {
        const wallet = await setActiveRegisteredWallet(walletId);
        if (
          isFastWalletRegistration(wallet) ||
          isRegisteredWalletOpen(walletId)
        ) {
          navigation.navigate('Home');
          return;
        }
        navigation.navigate('WalletSetup', {
          mode: 'open',
          openRequestId: Date.now(),
        });
      } finally {
        setOpeningWalletId(undefined);
      }
    },
    [
      isRegisteredWalletOpen,
      navigation,
      openingWalletId,
      setActiveRegisteredWallet,
    ],
  );

  return (
    <LinearGradient
      colors={['#12082A', '#0A0A18', '#07071A']}
      locations={[0, 0.52, 1]}
      style={s.container}
    >
      <StatusBar barStyle="light-content" backgroundColor="#12082A" />

      <View style={s.bgMonero} pointerEvents="none">
        <MoneroCoinGhost size={340} color="rgba(255,255,255,0.026)" />
      </View>

      <Animated.View
        style={[
          s.center,
          {
            opacity: contentOp,
            transform: [{ translateY: contentY }],
          },
        ]}
      >
        <View style={s.logoWrap}>
          <MoneroCoin size={116} />
        </View>

        <View style={s.textWrap}>
          <View style={s.titleRow}>
            <Text style={[s.titleWord, s.titleWhite]}>Monero</Text>
            <Text style={[s.titleWord, s.titleOrange]}> Fast Wallet</Text>
          </View>
          <Text style={s.subtitle}>{t('welcome.subtitle')}</Text>
        </View>
      </Animated.View>

      <View
        style={[s.bottom, { paddingBottom: Math.max(insets.bottom + 88, 106) }]}
      >
        {registeredWallets.length > 0 ? (
          <View style={s.savedWalletSection}>
            <Text style={s.savedWalletTitle}>{t('welcome.savedWallets')}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.savedWalletCarousel}
            >
              {registeredWallets.map(wallet => {
                const opening = openingWalletId === wallet.id;
                return (
                  <TouchableOpacity
                    key={wallet.id}
                    style={s.savedWalletCard}
                    activeOpacity={0.76}
                    disabled={Boolean(openingWalletId)}
                    onPress={() => void openSavedWallet(wallet.id)}
                  >
                    <MoneroCoin size={30} />
                    <View style={s.savedWalletCopy}>
                      <Text style={s.savedWalletName} numberOfLines={1}>
                        {walletDisplayName(wallet)}
                      </Text>
                      <Text style={s.savedWalletMeta} numberOfLines={1}>
                        {isFastWalletRegistration(wallet)
                          ? 'Fast Wallet'
                          : wallet.kind === 'hardware'
                          ? 'Ledger'
                          : 'Mainnet'}
                      </Text>
                    </View>
                    {opening ? <ActivityIndicator color="#F26822" /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
        <View style={s.searchSharingCard}>
          <View style={s.searchSharingCopy}>
            <Text style={s.searchSharingTitle}>
              {t('communityV1.shareSearches')}
            </Text>
            <Text style={s.searchSharingText}>
              {t('communityV1.shareSearchesWelcomeText')}
            </Text>
          </View>
          <Switch
            accessibilityLabel={t('communityV1.shareSearches')}
            onValueChange={updateSearchSharing}
            value={shareCommunitySearches}
            trackColor={{ false: 'rgba(255,255,255,0.2)', true: '#F26822' }}
            thumbColor="#FFF"
          />
        </View>
        <TouchableOpacity
          style={s.btn}
          activeOpacity={0.85}
          onPress={() =>
            registeredWallets.length
              ? navigation.navigate('WalletSetup')
              : void continueToSetup()
          }
        >
          <LinearGradient
            colors={['#F26822', '#D4551A']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={s.btnGrad}
          >
            <Text style={s.btnText}>{t('action.getStarted')}</Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
  },
  bgMonero: {
    position: 'absolute',
    top: '30%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  logoWrap: {
    width: 144,
    height: 144,
    borderRadius: 72,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 30,
  },
  textWrap: {
    alignItems: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: 16,
  },
  titleRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  titleWord: {
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 38,
    letterSpacing: 0,
  },
  titleWhite: {
    color: '#FFFFFF',
  },
  titleOrange: {
    color: '#F26822',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 17,
    lineHeight: 25,
    textAlign: 'center',
    fontWeight: '400',
  },
  bottom: {
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  savedWalletSection: {
    alignSelf: 'stretch',
    marginBottom: 18,
  },
  savedWalletTitle: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  savedWalletCarousel: {
    gap: 10,
    paddingRight: 24,
  },
  savedWalletCard: {
    width: 208,
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  savedWalletCopy: { flex: 1 },
  savedWalletName: { color: '#FFF', fontSize: 15, fontWeight: '800' },
  savedWalletMeta: {
    color: 'rgba(255,255,255,0.46)',
    fontSize: 12,
    marginTop: 3,
  },
  btn: {
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
  },
  searchSharingCard: {
    alignSelf: 'stretch',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14,
    padding: 13,
  },
  searchSharingCopy: { flex: 1 },
  searchSharingTitle: { color: '#FFF', fontSize: 14, fontWeight: '800' },
  searchSharingText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
  },
  profilePanel: { alignSelf: 'stretch', marginBottom: 18, gap: 8 },
  profileEyebrow: {
    color: 'rgba(255,255,255,0.55)',
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 1,
  },
  profileLead: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 3,
  },
  profileCard: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    padding: 13,
    backgroundColor: 'rgba(255,255,255,0.045)',
  },
  profileCardSelected: {
    borderColor: '#F26822',
    backgroundColor: 'rgba(242,104,34,0.13)',
  },
  profileTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
  },
  profileTitle: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  profileMeter: { color: '#F5B744', fontSize: 12, letterSpacing: 1 },
  profileDetail: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 5,
  },
  infoLink: { color: '#F5B744', fontSize: 12, fontWeight: '700', marginTop: 9 },
  profileFootnote: {
    color: 'rgba(255,255,255,0.42)',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  infoBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center',
    padding: 24,
  },
  infoSheet: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(242,104,34,0.5)',
    backgroundColor: '#161223',
    padding: 21,
    gap: 12,
  },
  infoTitle: { color: '#FFF', fontSize: 21, fontWeight: '800' },
  infoCopy: { color: 'rgba(255,255,255,0.75)', fontSize: 14, lineHeight: 20 },
  infoClose: {
    backgroundColor: '#F26822',
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  infoCloseText: { color: '#FFF', fontWeight: '800', fontSize: 15 },
  btnGrad: {
    height: 60,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
