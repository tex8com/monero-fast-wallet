import Clipboard from '@react-native-clipboard/clipboard';
import React, {useState} from 'react';
import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {Icon} from '../components/Icon';
import {useI18n, type TranslationKey} from '../i18n';
import {colors, radius, spacing} from '../theme/colors';
import {
  PROJECT_PAGE_ADDRESSES,
  PROJECT_SERVICE_LINKS,
  PROJECT_SOURCE_URL,
  type ProjectServiceId,
} from '../../../../packages/wallet-shared/src/projectServices';

const SERVICE_LABELS: Record<ProjectServiceId, TranslationKey> = {
  wallet: 'projectPage.serviceWallet',
  node: 'projectPage.serviceNode',
  relay: 'projectPage.serviceRelay',
  worker: 'projectPage.serviceWorker',
  registry: 'projectPage.serviceRegistry',
  all: 'projectPage.serviceAll',
};

export default function ProjectPageScreen({navigation}: any) {
  const {t} = useI18n();
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const copyAddress = (address: string) => {
    Clipboard.setString(address);
    setCopiedAddress(address);
  };

  return (
    <ScrollView
      contentContainerStyle={s.content}
      showsVerticalScrollIndicator={false}
      style={s.screen}
    >
      <TouchableOpacity
        accessibilityRole="button"
        onPress={() => navigation.goBack()}
        style={s.back}
      >
        <Icon name="arrow-left" color={colors.textMuted} size={19} />
        <Text style={s.backText}>{t('action.back')}</Text>
      </TouchableOpacity>

      <View style={s.hero}>
        <View style={s.heroIcon}>
          <Icon name="globe" color={colors.orange} size={28} />
        </View>
        <Text style={s.eyebrow}>{t('projectPage.eyebrow')}</Text>
        <Text style={s.title}>{t('projectPage.title')}</Text>
        <Text style={s.subtitle}>{t('projectPage.subtitle')}</Text>
      </View>

      <Text style={s.sectionLabel}>{t('projectPage.addresses')}</Text>
      <Text style={s.sectionHint}>{t('projectPage.addressesHint')}</Text>
      <View style={s.addressList}>
        {PROJECT_PAGE_ADDRESSES.map(item => (
          <View key={item.id} style={s.addressCard}>
            <View style={s.addressHeader}>
              <View style={s.transportIcon}>
                <Icon
                  name={item.transport === 'onion' ? 'onion' : 'globe'}
                  color={
                    item.transport === 'onion'
                      ? colors.orangeLight
                      : colors.success
                  }
                  size={19}
                />
              </View>
              <View style={s.addressCopy}>
                <Text style={s.addressLabel}>{item.label}</Text>
                <Text
                  style={[
                    s.transport,
                    item.transport === 'onion' && s.transportOnion,
                  ]}
                >
                  {item.transport === 'onion'
                    ? t('projectPage.onion')
                    : t('projectPage.clearnet')}
                </Text>
              </View>
            </View>
            <Text selectable style={s.address}>
              {item.address}
            </Text>
            <View style={s.addressActions}>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => copyAddress(item.address)}
                style={s.smallButton}
              >
                <Icon name="copy" color={colors.orange} size={16} />
                <Text style={s.smallButtonText}>
                  {copiedAddress === item.address
                    ? t('projectPage.copied')
                    : t('projectPage.copy')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="link"
                onPress={() => Linking.openURL(item.url).catch(() => undefined)}
                style={s.smallButton}
              >
                <Text style={s.smallButtonText}>{t('projectPage.open')}</Text>
                <Icon name="arrow-right" color={colors.orange} size={16} />
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>
      <Text style={s.onionHint}>{t('projectPage.onionHint')}</Text>

      <Text style={s.sectionLabel}>{t('projectPage.selfHosting')}</Text>
      <View style={s.hostCard}>
        <View style={s.hostIcon}>
          <Icon name="globe" color={colors.orangeLight} size={21} />
        </View>
        <View style={s.hostCopy}>
          <Text style={s.hostTitle}>{t('projectPage.ownNodeTitle')}</Text>
          <Text style={s.hostText}>{t('projectPage.ownNodeText')}</Text>
        </View>
      </View>
      <View style={s.hostCard}>
        <View style={s.hostIcon}>
          <Icon name="settings" color={colors.orangeLight} size={21} />
        </View>
        <View style={s.hostCopy}>
          <Text style={s.hostTitle}>{t('projectPage.ownWorkerTitle')}</Text>
          <Text style={s.hostText}>{t('projectPage.ownWorkerText')}</Text>
        </View>
      </View>

      <Text style={s.sectionLabel}>{t('projectPage.services')}</Text>
      <Text style={s.sectionHint}>{t('projectPage.servicesHint')}</Text>
      <View style={s.serviceGrid}>
        {PROJECT_SERVICE_LINKS.map(link => (
          <TouchableOpacity
            accessibilityRole="link"
            activeOpacity={0.75}
            key={link.id}
            onPress={() => Linking.openURL(link.url).catch(() => undefined)}
            style={s.serviceLink}
          >
            <Text style={s.serviceLinkText}>{t(SERVICE_LABELS[link.id])}</Text>
            <Icon name="arrow-right" color={colors.orange} size={16} />
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          accessibilityRole="link"
          activeOpacity={0.75}
          onPress={() => Linking.openURL(PROJECT_SOURCE_URL).catch(() => undefined)}
          style={s.serviceLink}
        >
          <Text style={s.serviceLinkText}>{t('projectPage.sourceCode')}</Text>
          <Icon name="arrow-right" color={colors.orange} size={16} />
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: {backgroundColor: colors.bg, flex: 1},
  content: {
    paddingBottom: 112,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  back: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 7,
    marginBottom: 15,
    paddingVertical: 5,
  },
  backText: {color: colors.textMuted, fontSize: 14, fontWeight: '700'},
  hero: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: 'rgba(242,104,34,0.32)',
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
  },
  heroIcon: {
    alignItems: 'center',
    backgroundColor: colors.orangeMuted,
    borderRadius: 26,
    height: 52,
    justifyContent: 'center',
    marginBottom: 12,
    width: 52,
  },
  eyebrow: {
    color: colors.orangeLight,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.textPrimary,
    fontSize: 27,
    fontWeight: '900',
    letterSpacing: -0.5,
    marginTop: 7,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8,
    textAlign: 'center',
  },
  sectionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginTop: 24,
    textTransform: 'uppercase',
  },
  sectionHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 10,
    marginTop: 5,
  },
  addressList: {gap: 9},
  addressCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 15,
  },
  addressHeader: {alignItems: 'center', flexDirection: 'row', gap: 10},
  transportIcon: {
    alignItems: 'center',
    backgroundColor: colors.bgElevated,
    borderRadius: 10,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  addressCopy: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 8,
  },
  addressLabel: {color: colors.textPrimary, fontSize: 14, fontWeight: '800'},
  transport: {
    backgroundColor: `${colors.success}18`,
    borderRadius: radius.full,
    color: colors.success,
    fontSize: 9,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
    textTransform: 'uppercase',
  },
  transportOnion: {
    backgroundColor: `${colors.orange}18`,
    color: colors.orangeLight,
  },
  address: {
    color: colors.textMuted,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 11,
  },
  addressActions: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
    marginTop: 11,
  },
  smallButton: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  smallButtonText: {color: colors.orangeLight, fontSize: 11, fontWeight: '800'},
  onionHint: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 9,
  },
  hostCard: {
    alignItems: 'flex-start',
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 13,
    marginTop: 9,
    padding: 16,
  },
  hostIcon: {
    alignItems: 'center',
    backgroundColor: colors.orangeMuted,
    borderRadius: 11,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  hostCopy: {flex: 1},
  hostTitle: {color: colors.textPrimary, fontSize: 15, fontWeight: '800'},
  hostText: {color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 5},
  serviceGrid: {gap: 8},
  serviceLink: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: 15,
  },
  serviceLinkText: {color: colors.textPrimary, fontSize: 13, fontWeight: '700'},
});
