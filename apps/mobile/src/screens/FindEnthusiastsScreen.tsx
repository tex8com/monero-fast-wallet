import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import {
  acceptCommunityContact,
  getEnthusiastLocationDebug,
  listCommunityContacts,
  listNearbyEnthusiasts,
  loadCommunityProfile,
  loadEnthusiastDiscoveryPreference,
  refreshApproximateEnthusiastLocation,
  removeCommunityListing,
  requestCommunityContact,
  setEnthusiastDiscoveryEnabled,
  setEnthusiastDiscoveryRadius,
  updateCommunityDisplayName,
  type CommunityContact,
  type CommunityProfile,
  type EnthusiastDiscoveryPreference,
  type EnthusiastLocationDebug,
  type EnthusiastRadiusKm,
  type NearbyEnthusiast,
} from '../backend/EnthusiastDiscoveryService';
import { colors, spacing } from '../theme/colors';

const RADII: EnthusiastRadiusKm[] = [5, 10, 25];

export default function FindEnthusiastsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [preference, setPreference] = useState<EnthusiastDiscoveryPreference>();
  const [displayName, setDisplayName] = useState('');
  const [ownProfile, setOwnProfile] = useState<CommunityProfile>();
  const [locationDebug, setLocationDebug] =
    useState<EnthusiastLocationDebug>(getEnthusiastLocationDebug());
  const [nearby, setNearby] = useState<NearbyEnthusiast[]>([]);
  const [contacts, setContacts] = useState<CommunityContact[]>([]);
  const [busy, setBusy] = useState(false);
  const [communityBusy, setCommunityBusy] = useState(false);
  const [communityError, setCommunityError] = useState<string>();
  // Opening Community gets one fresh approximate fix. Changing the search
  // radius must never trigger another GPS request.
  const locationRefreshStarted = useRef(false);

  const reloadCommunity = useCallback(
    async (activePreference: EnthusiastDiscoveryPreference) => {
      if (
        !activePreference.enabled ||
        activePreference.locationStatus !== 'ready'
      ) {
        setOwnProfile(undefined);
        setNearby([]);
        setContacts([]);
        return;
      }
      setCommunityBusy(true);
      setCommunityError(undefined);
      try {
        const [profile, nextNearby, nextContacts] = await Promise.all([
          loadCommunityProfile(),
          listNearbyEnthusiasts(activePreference.radiusKm),
          listCommunityContacts(),
        ]);
        setDisplayName(profile.displayName);
        setOwnProfile(profile.visible ? profile : undefined);
        setNearby(nextNearby);
        setContacts(nextContacts);
      } catch {
        setCommunityError(t('enthusiasts.serverError'));
      } finally {
        setCommunityBusy(false);
      }
    },
    [t],
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      locationRefreshStarted.current = false;

      const refreshOnScreenOpen = async () => {
        const current = await loadEnthusiastDiscoveryPreference();
        if (!active) {
          return;
        }
        setPreference(current);

        // Ask the operating system for one fresh approximate location when
        // Community opens. This is deliberately independent of the radius:
        // 5/10/25 km only changes the server-side lookup, never GPS access.
        if (!locationRefreshStarted.current) {
          locationRefreshStarted.current = true;
          setBusy(true);
          setLocationDebug({ status: 'requesting' });
          try {
            const next = await refreshApproximateEnthusiastLocation(true);
            if (!active) {
              return;
            }
            setLocationDebug(getEnthusiastLocationDebug());
            setPreference(next);
            if (next.enabled) {
              await reloadCommunity(next);
            }
          } finally {
            if (active) {
              setBusy(false);
            }
          }
          return;
        }

        if (current.locationStatus === 'ready') {
          await reloadCommunity(current);
        }
      };

      refreshOnScreenOpen().catch(() => undefined);
      return () => {
        active = false;
      };
    }, [reloadCommunity]),
  );

  const toggleDiscovery = async (enabled: boolean) => {
    setBusy(true);
    try {
      let next = await setEnthusiastDiscoveryEnabled(enabled);
      if (enabled) {
        setLocationDebug({ status: 'requesting' });
        next = await refreshApproximateEnthusiastLocation();
        setLocationDebug(getEnthusiastLocationDebug());
      }
      setPreference(next);
      await reloadCommunity(next);
    } finally {
      setBusy(false);
    }
  };

  const chooseRadius = async (radiusKm: EnthusiastRadiusKm) => {
    const next = await setEnthusiastDiscoveryRadius(radiusKm);
    setPreference(next);
    if (next.enabled) {
      await reloadCommunity(next);
    }
  };

  const saveDisplayName = async () => {
    if (!preference || displayName.trim().length < 2) {
      return;
    }
    setCommunityBusy(true);
    try {
      const profile = await updateCommunityDisplayName(displayName, preference);
      setDisplayName(profile.displayName);
      setOwnProfile(profile);
      await reloadCommunity(preference);
    } catch {
      setCommunityError(t('enthusiasts.serverError'));
    } finally {
      setCommunityBusy(false);
    }
  };

  const removeListing = () => {
    Alert.alert(
      t('enthusiasts.removeListingTitle'),
      t('enthusiasts.removeListingDescription'),
      [
        { text: t('action.cancel'), style: 'cancel' },
        {
          text: t('enthusiasts.removeListing'),
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setCommunityError(undefined);
            removeCommunityListing()
              .then(next => {
                setPreference(next);
                setOwnProfile(undefined);
                setNearby([]);
              })
              .catch(error =>
                setCommunityError(
                  error instanceof Error ? error.message : String(error),
                ),
              )
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  };

  const connect = async (profile: NearbyEnthusiast) => {
    setCommunityBusy(true);
    try {
      if (profile.relationship === 'incoming') {
        await acceptCommunityContact(profile.identityId);
      } else if (profile.relationship === 'none') {
        await requestCommunityContact(profile.identityId);
      }
      if (preference) {
        await reloadCommunity(preference);
      }
    } finally {
      setCommunityBusy(false);
    }
  };

  const openContact = async (contact: CommunityContact) => {
    if (contact.status === 'incoming') {
      setCommunityBusy(true);
      try {
        await acceptCommunityContact(contact.identityId);
        if (preference) {
          await reloadCommunity(preference);
        }
      } finally {
        setCommunityBusy(false);
      }
      return;
    }
    if (contact.status === 'connected') {
      navigation.navigate('EnthusiastChat', { peer: contact });
    }
  };

  const enabled = preference?.enabled === true;
  const ready = enabled && preference?.locationStatus === 'ready';

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView
        contentContainerStyle={[
          s.scroll,
          { paddingBottom: insets.bottom + 120 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.header}>
          <TouchableOpacity
            style={s.iconButton}
            onPress={() => navigation.navigate('Menu')}
            accessibilityLabel={t('action.back')}
          >
            <Icon name="arrow-left" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
          <View style={s.headerText}>
            <Text style={s.title}>{t('enthusiasts.title')}</Text>
            <Text style={s.subtitle}>{t('enthusiasts.subtitle')}</Text>
          </View>
        </View>

        <View style={s.visibilityRow}>
          <View style={s.visibilityIcon}>
            <Icon name="users" size={22} color={colors.orange} />
          </View>
          <View style={s.visibilityText}>
            <Text style={s.sectionTitle}>{t('enthusiasts.visibility')}</Text>
            <Text style={s.sectionText}>
              {ready
                ? t('enthusiasts.status.ready')
                : enabled
                ? t(
                    `enthusiasts.status.${
                      preference?.locationStatus ?? 'not_requested'
                    }`,
                  )
                : t('enthusiasts.status.off')}
            </Text>
          </View>
          <Switch
            value={enabled}
            disabled={busy}
            onValueChange={value =>
              toggleDiscovery(value).catch(() => undefined)
            }
            trackColor={{ false: colors.surface, true: colors.orange }}
            thumbColor="#FFFFFF"
          />
        </View>

        <Text style={s.label}>{t('enthusiasts.radius')}</Text>
        <View style={s.radiusControl}>
          {RADII.map(radiusKm => {
            const selected = preference?.radiusKm === radiusKm;
            return (
              <TouchableOpacity
                key={radiusKm}
                style={[s.radiusButton, selected && s.radiusButtonActive]}
                onPress={() => chooseRadius(radiusKm).catch(() => undefined)}
                disabled={!enabled}
              >
                <Text style={[s.radiusText, selected && s.radiusTextActive]}>
                  {radiusKm} km
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={s.privacyBand}>
          <Icon name="lock" size={19} color={colors.success} />
          <Text style={s.privacyText}>{t('enthusiasts.privacy')}</Text>
        </View>

        <View style={s.debugCard}>
          <View style={s.debugHeader}>
            <Icon name="map-pin" size={17} color={colors.orange} />
            <Text style={s.debugTitle}>{t('enthusiasts.debugGps')}</Text>
          </View>
          <Text style={s.debugValue}>
            {locationDebug.status === 'ready' &&
            typeof locationDebug.latitude === 'number' &&
            typeof locationDebug.longitude === 'number'
              ? `${locationDebug.latitude.toFixed(
                  6,
                )}, ${locationDebug.longitude.toFixed(6)}${
                  typeof locationDebug.accuracyMeters === 'number'
                    ? ` · ±${locationDebug.accuracyMeters} m`
                    : ''
                }`
              : t(`enthusiasts.status.${locationDebug.status}`)}
          </Text>
          <Text style={s.debugHint}>
            {t('enthusiasts.debugLocalOnly')}
          </Text>
        </View>

        {ready ? (
          <>
            <Text style={s.label}>{t('enthusiasts.yourName')}</Text>
            <View style={s.nameRow}>
              <TextInput
                value={displayName}
                onChangeText={setDisplayName}
                maxLength={32}
                style={s.nameInput}
                placeholder={t('enthusiasts.namePlaceholder')}
                placeholderTextColor={colors.textMuted}
              />
              <TouchableOpacity style={s.saveButton} onPress={saveDisplayName}>
                <Icon name="check" size={19} color="#FFFFFF" />
              </TouchableOpacity>
            </View>

            {ownProfile ? (
              <View style={s.listingCard}>
                <View style={s.listingContent}>
                  <Text style={s.listingEyebrow}>
                    {t('enthusiasts.myListing')}
                  </Text>
                  <Text style={s.listingName}>
                    {ownProfile.displayName}
                  </Text>
                  <Text style={s.listingDetail}>
                    {t('enthusiasts.listingVisible', {
                      radius: ownProfile.radiusKm,
                    })}
                  </Text>
                </View>
                <TouchableOpacity
                  style={s.listingRemove}
                  onPress={removeListing}
                  disabled={busy || communityBusy}
                  accessibilityLabel={t('enthusiasts.removeListing')}
                >
                  <Icon name="close" size={21} color={colors.error} />
                </TouchableOpacity>
              </View>
            ) : null}

            <SectionHeader
              title={t('enthusiasts.connections')}
              loading={communityBusy}
            />
            {contacts.length === 0 ? (
              <Text style={s.emptyText}>{t('enthusiasts.noConnections')}</Text>
            ) : (
              contacts.map(contact => (
                <PersonRow
                  key={contact.identityId}
                  name={contact.displayName}
                  detail={t(`enthusiasts.contact.${contact.status}`)}
                  action={
                    contact.status === 'incoming'
                      ? t('enthusiasts.accept')
                      : contact.status === 'connected'
                      ? t('enthusiasts.chat')
                      : undefined
                  }
                  onPress={() => openContact(contact).catch(() => undefined)}
                />
              ))
            )}

            <SectionHeader title={t('enthusiasts.nearby')} loading={false} />
            {nearby.length === 0 ? (
              <View style={s.emptyState}>
                <Icon name="map-pin" size={27} color={colors.textMuted} />
                <Text style={s.emptyTitle}>{t('enthusiasts.emptyTitle')}</Text>
                <Text style={s.emptyText}>{t('enthusiasts.emptyText')}</Text>
              </View>
            ) : (
              nearby.map(profile => (
                <PersonRow
                  key={profile.identityId}
                  name={profile.displayName}
                  detail={t('enthusiasts.distance', {
                    distance: profile.approximateDistanceKm,
                  })}
                  action={
                    profile.relationship === 'none'
                      ? t('enthusiasts.connect')
                      : profile.relationship === 'incoming'
                      ? t('enthusiasts.accept')
                      : profile.relationship === 'connected'
                      ? t('enthusiasts.chat')
                      : t('enthusiasts.requested')
                  }
                  disabled={profile.relationship === 'outgoing'}
                  onPress={() =>
                    profile.relationship === 'connected'
                      ? navigation.navigate('EnthusiastChat', { peer: profile })
                      : connect(profile).catch(() => undefined)
                  }
                />
              ))
            )}
          </>
        ) : null}

        {communityError ? (
          <Text style={s.errorText}>{communityError}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SectionHeader({
  title,
  loading,
}: {
  title: string;
  loading: boolean;
}) {
  return (
    <View style={s.resultsHeader}>
      <Text style={s.resultsTitle}>{title}</Text>
      {loading ? (
        <ActivityIndicator size="small" color={colors.orange} />
      ) : null}
    </View>
  );
}

function PersonRow({
  name,
  detail,
  action,
  disabled,
  onPress,
}: {
  name: string;
  detail: string;
  action?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <View style={s.personRow}>
      <View style={s.personAvatar}>
        <Icon name="users" size={18} color={colors.orange} />
      </View>
      <View style={s.personText}>
        <Text style={s.personName}>{name}</Text>
        <Text style={s.personDetail}>{detail}</Text>
      </View>
      {action ? (
        <TouchableOpacity
          disabled={disabled}
          onPress={onPress}
          style={s.personAction}
        >
          <Text style={[s.personActionText, disabled && s.disabledText]}>
            {action}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    marginBottom: 30,
  },
  iconButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: { flex: 1, paddingTop: 2 },
  title: {
    color: colors.textPrimary,
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 5,
  },
  visibilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 12,
  },
  visibilityIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.orangeMuted,
  },
  visibilityText: { flex: 1 },
  sectionTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: '800' },
  sectionText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 24,
    marginBottom: 10,
  },
  radiusControl: {
    minHeight: 50,
    flexDirection: 'row',
    padding: 4,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  radiusButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  radiusButtonActive: { backgroundColor: colors.orange },
  radiusText: { color: colors.textSecondary, fontSize: 14, fontWeight: '800' },
  radiusTextActive: { color: '#FFFFFF' },
  privacyBand: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 22,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  privacyText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  debugCard: {
    marginTop: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.bgCard,
  },
  debugHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  debugTitle: {
    color: colors.orange,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  debugValue: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
    marginTop: 10,
  },
  debugHint: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 7,
  },
  nameRow: { flexDirection: 'row', gap: 8 },
  nameInput: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    color: colors.textPrimary,
    fontSize: 15,
  },
  saveButton: {
    width: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.orange,
  },
  listingCard: {
    minHeight: 78,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    paddingLeft: 15,
    borderWidth: 1,
    borderColor: colors.success,
    borderRadius: 10,
    backgroundColor: colors.bgCard,
  },
  listingContent: { flex: 1, paddingVertical: 12 },
  listingEyebrow: {
    color: colors.success,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  listingName: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
    marginTop: 4,
  },
  listingDetail: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 3,
  },
  listingRemove: {
    width: 56,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 28,
    marginBottom: 10,
  },
  resultsTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '800' },
  personRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  personAvatar: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: colors.orangeMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  personText: { flex: 1 },
  personName: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  personDetail: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  personAction: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  personActionText: { color: colors.orange, fontSize: 13, fontWeight: '800' },
  disabledText: { color: colors.textMuted },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
    marginTop: 13,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 6,
  },
  errorText: {
    color: colors.error,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 16,
  },
});
