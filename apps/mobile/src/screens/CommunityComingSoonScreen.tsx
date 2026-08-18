import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { useI18n, type TranslationKey } from '../i18n';
import { colors } from '../theme/colors';

type Feature = {
  icon: IconName;
  titleKey: TranslationKey;
  textKey: TranslationKey;
};

const FEATURES: ReadonlyArray<Feature> = [
  {
    icon: 'file',
    titleKey: 'communitySoon.bulletinTitle',
    textKey: 'communitySoon.bulletinText',
  },
  {
    icon: 'users',
    titleKey: 'communitySoon.meetTitle',
    textKey: 'communitySoon.meetText',
  },
  {
    icon: 'message-circle',
    titleKey: 'communitySoon.matrixTitle',
    textKey: 'communitySoon.matrixText',
  },
  {
    icon: 'package',
    titleKey: 'communitySoon.profilesTitle',
    textKey: 'communitySoon.profilesText',
  },
];

export default function CommunityComingSoonScreen() {
  const { t } = useI18n();

  return (
    <ScrollView
      contentContainerStyle={s.content}
      showsVerticalScrollIndicator={false}
      style={s.screen}
    >
      <View style={s.hero}>
        <View style={s.lockCircle}>
          <Icon name="lock" color={colors.orange} size={27} />
        </View>
        <View style={s.statusPill}>
          <View style={s.statusDot} />
          <Text style={s.statusText}>{t('communitySoon.eyebrow')}</Text>
        </View>
        <Text style={s.title}>{t('communitySoon.title')}</Text>
        <Text style={s.subtitle}>{t('communitySoon.subtitle')}</Text>
      </View>

      <Text style={s.sectionLabel}>{t('communitySoon.plannedFeatures')}</Text>
      <View style={s.featureList}>
        {FEATURES.map(feature => (
          <View key={feature.titleKey} style={s.featureCard}>
            <View style={s.featureIcon}>
              <Icon name={feature.icon} color={colors.orangeLight} size={21} />
            </View>
            <View style={s.featureCopy}>
              <Text style={s.featureTitle}>{t(feature.titleKey)}</Text>
              <Text style={s.featureText}>{t(feature.textKey)}</Text>
            </View>
          </View>
        ))}
      </View>

      <View style={s.verificationCard}>
        <View style={s.verificationHeader}>
          <View style={s.verifiedMark}>
            <Icon name="check" color={colors.bg} size={14} strokeWidth={2.8} />
          </View>
          <Text style={s.verificationTitle}>
            {t('communitySoon.verifiedTitle')}
          </Text>
          <View style={s.verifiedBadge}>
            <Text style={s.verifiedBadgeText}>
              {t('communitySoon.verifiedBadge')}
            </Text>
          </View>
        </View>
        <Text style={s.verificationText}>
          {t('communitySoon.verifiedText')}
        </Text>
        <Text style={s.verificationNote}>
          {t('communitySoon.verifiedNote')}
        </Text>
      </View>

      <View style={s.policyCard}>
        <View style={s.policyIcon}>
          <Icon name="info" color={colors.warning} size={20} />
        </View>
        <View style={s.featureCopy}>
          <Text style={s.policyTitle}>{t('communitySoon.noMarketplaceTitle')}</Text>
          <Text style={s.policyText}>{t('communitySoon.noMarketplaceText')}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    paddingBottom: 112,
    paddingHorizontal: 20,
    paddingTop: 22,
  },
  hero: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: 'rgba(242,104,34,0.35)',
    borderRadius: 24,
    borderWidth: 1,
    overflow: 'hidden',
    paddingBottom: 28,
    paddingHorizontal: 24,
    paddingTop: 26,
  },
  lockCircle: {
    alignItems: 'center',
    backgroundColor: colors.orangeMuted,
    borderColor: 'rgba(242,104,34,0.32)',
    borderRadius: 28,
    borderWidth: 1,
    height: 56,
    justifyContent: 'center',
    marginBottom: 16,
    width: 56,
  },
  statusPill: {
    alignItems: 'center',
    backgroundColor: 'rgba(242,104,34,0.12)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 7,
    marginBottom: 12,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  statusDot: {
    backgroundColor: colors.orange,
    borderRadius: 4,
    height: 7,
    width: 7,
  },
  statusText: {
    color: colors.orangeLight,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.textPrimary,
    fontSize: 29,
    fontWeight: '900',
    letterSpacing: -0.7,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 9,
    maxWidth: 350,
    textAlign: 'center',
  },
  sectionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.9,
    marginBottom: 11,
    marginTop: 25,
    textTransform: 'uppercase',
  },
  featureList: {
    gap: 10,
  },
  featureCard: {
    alignItems: 'flex-start',
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    padding: 16,
  },
  featureIcon: {
    alignItems: 'center',
    backgroundColor: colors.orangeMuted,
    borderRadius: 12,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  featureCopy: {
    flex: 1,
  },
  featureTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 4,
  },
  featureText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  verificationCard: {
    backgroundColor: 'rgba(0,214,143,0.07)',
    borderColor: 'rgba(0,214,143,0.28)',
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 14,
    padding: 17,
  },
  verificationHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
  },
  verifiedMark: {
    alignItems: 'center',
    backgroundColor: colors.success,
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  verificationTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
  },
  verifiedBadge: {
    backgroundColor: 'rgba(0,214,143,0.13)',
    borderColor: 'rgba(0,214,143,0.32)',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  verifiedBadgeText: {
    color: colors.success,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  verificationText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 11,
  },
  verificationNote: {
    color: colors.textSecondary,
    fontSize: 11,
    fontStyle: 'italic',
    lineHeight: 17,
    marginTop: 8,
  },
  policyCard: {
    alignItems: 'flex-start',
    backgroundColor: 'rgba(255,184,0,0.06)',
    borderColor: 'rgba(255,184,0,0.24)',
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 13,
    marginTop: 12,
    padding: 17,
  },
  policyIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,184,0,0.11)',
    borderRadius: 11,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  policyTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 4,
  },
  policyText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
});
