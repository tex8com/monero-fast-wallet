import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  ActivityIndicator,
  ScrollView,
  StatusBar,
  StyleSheet,
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
            <Text style={[s.titleWord, s.titleOrange]}> Wallet</Text>
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
        <TouchableOpacity
          style={s.btn}
          activeOpacity={0.85}
          onPress={() => navigation.navigate('WalletSetup')}
        >
          <LinearGradient
            colors={['#F26822', '#D4551A']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={s.btnGrad}
          >
            <Text style={s.btnText}>{t('action.continue')}</Text>
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
