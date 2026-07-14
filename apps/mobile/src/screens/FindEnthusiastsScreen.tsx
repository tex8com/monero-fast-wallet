import React, {useCallback, useEffect, useState} from 'react';
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
import {useFocusEffect} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Icon} from '../components/Icon';
import {useI18n} from '../i18n';
import {
  acceptCommunityContact,
  deleteCommunityIdentity,
  listCommunityContacts,
  listNearbyEnthusiasts,
  loadCommunityProfile,
  loadEnthusiastDiscoveryPreference,
  refreshApproximateEnthusiastLocation,
  requestCommunityContact,
  setEnthusiastDiscoveryEnabled,
  setEnthusiastDiscoveryRadius,
  updateCommunityDisplayName,
  type CommunityContact,
  type EnthusiastDiscoveryPreference,
  type EnthusiastRadiusKm,
  type NearbyEnthusiast,
} from '../services/EnthusiastDiscoveryService';
import {colors, spacing} from '../theme/colors';

const RADII: EnthusiastRadiusKm[] = [5, 10, 25];

export default function FindEnthusiastsScreen({navigation}: any) {
  const insets = useSafeAreaInsets();
  const {t} = useI18n();
  const [preference, setPreference] =
    useState<EnthusiastDiscoveryPreference>();
  const [displayName, setDisplayName] = useState('');
  const [nearby, setNearby] = useState<NearbyEnthusiast[]>([]);
  const [contacts, setContacts] = useState<CommunityContact[]>([]);
  const [busy, setBusy] = useState(false);
  const [communityBusy, setCommunityBusy] = useState(false);
  const [communityError, setCommunityError] = useState<string>();

  const reloadPreference = useCallback(async () => {
    setPreference(await loadEnthusiastDiscoveryPreference());
  }, []);

  const reloadCommunity = useCallback(
    async (activePreference: EnthusiastDiscoveryPreference) => {
      if (!activePreference.enabled || activePreference.locationStatus !== 'ready') {
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
        setNearby(nextNearby);
        setContacts(nextContacts);
      } catch (error) {
        setCommunityError(
          error instanceof Error ? error.message : t('enthusiasts.serverError'),
        );
      } finally {
        setCommunityBusy(false);
      }
    },
    [t],
  );

  useFocusEffect(
    useCallback(() => {
      reloadPreference().catch(() => undefined);
    }, [reloadPreference]),
  );

  useEffect(() => {
    if (!preference || busy) {
      return;
    }
    if (
      preference.enabled &&
      preference.locationStatus === 'not_requested'
    ) {
      setBusy(true);
      refreshApproximateEnthusiastLocation()
        .then(next => {
          setPreference(next);
          return reloadCommunity(next);
        })
        .finally(() => setBusy(false));
    } else if (preference.locationStatus === 'ready') {
      reloadCommunity(preference).catch(() => undefined);
    }
  }, [busy, preference, reloadCommunity]);

  const toggleDiscovery = async (enabled: boolean) => {
    setBusy(true);
    try {
      let next = await setEnthusiastDiscoveryEnabled(enabled);
      if (enabled) {
        next = await refreshApproximateEnthusiastLocation();
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
      const refreshed = await refreshApproximateEnthusiastLocation();
      setPreference(refreshed);
      await reloadCommunity(refreshed);
    }
  };

  const retry = async () => {
    setBusy(true);
    try {
      const next = await refreshApproximateEnthusiastLocation();
      setPreference(next);
      await reloadCommunity(next);
    } finally {
      setBusy(false);
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
      await reloadCommunity(preference);
    } catch (error) {
      setCommunityError(error instanceof Error ? error.message : String(error));
    } finally {
      setCommunityBusy(false);
    }
  };

  const removeCommunityIdentity = () => {
    Alert.alert(
      t('enthusiasts.deleteTitle'),
      t('enthusiasts.deleteDescription'),
      [
        {text: t('action.cancel'), style: 'cancel'},
        {
          text: t('enthusiasts.deleteAction'),
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setCommunityError(undefined);
            deleteCommunityIdentity()
              .then(() => setEnthusiastDiscoveryEnabled(false))
              .then(next => {
                setPreference(next);
                setDisplayName('');
                setNearby([]);
                setContacts([]);
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
      navigation.navigate('EnthusiastChat', {peer: contact});
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
          {paddingTop: insets.top + 14, paddingBottom: insets.bottom + 120},
        ]}
        showsVerticalScrollIndicator={false}>
        <View style={s.header}>
          <TouchableOpacity
            style={s.iconButton}
            onPress={() => navigation.navigate('Menu')}
            accessibilityLabel={t('action.back')}>
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
                  ? t(`enthusiasts.status.${preference?.locationStatus ?? 'not_requested'}`)
                  : t('enthusiasts.status.off')}
            </Text>
          </View>
          {busy ? (
            <ActivityIndicator color={colors.orange} />
          ) : (
            <Switch
              value={enabled}
              onValueChange={value => toggleDiscovery(value).catch(() => undefined)}
              trackColor={{false: colors.surface, true: colors.orange}}
              thumbColor="#FFFFFF"
            />
          )}
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
                disabled={!enabled}>
                <Text style={[s.radiusText, selected && s.radiusTextActive]}>
                  {radiusKm} km
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {enabled && (!ready || communityError) ? (
          <TouchableOpacity style={s.retryButton} onPress={retry}>
            <Icon name="arrow-right" size={18} color="#FFFFFF" />
            <Text style={s.retryText}>{t('action.retry')}</Text>
          </TouchableOpacity>
        ) : null}

        <View style={s.privacyBand}>
          <Icon name="lock" size={19} color={colors.success} />
          <Text style={s.privacyText}>{t('enthusiasts.privacy')}</Text>
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
                      ? navigation.navigate('EnthusiastChat', {peer: profile})
                      : connect(profile).catch(() => undefined)
                  }
                />
              ))
            )}
          </>
        ) : null}

        {communityError ? <Text style={s.errorText}>{communityError}</Text> : null}
        {enabled ? (
          <TouchableOpacity
            style={s.deleteButton}
            onPress={removeCommunityIdentity}
            disabled={busy || communityBusy}>
            <Icon name="trash" size={18} color={colors.error} />
            <Text style={s.deleteText}>{t('enthusiasts.deleteAction')}</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SectionHeader({title, loading}: {title: string; loading: boolean}) {
  return (
    <View style={s.resultsHeader}>
      <Text style={s.resultsTitle}>{title}</Text>
      {loading ? <ActivityIndicator size="small" color={colors.orange} /> : null}
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
        <TouchableOpacity disabled={disabled} onPress={onPress} style={s.personAction}>
          <Text style={[s.personActionText, disabled && s.disabledText]}>{action}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  scroll: {paddingHorizontal: spacing.lg},
  header: {flexDirection: 'row', alignItems: 'flex-start', gap: 14, marginBottom: 30},
  iconButton: {width: 42, height: 42, alignItems: 'center', justifyContent: 'center'},
  headerText: {flex: 1, paddingTop: 2},
  title: {color: colors.textPrimary, fontSize: 25, lineHeight: 31, fontWeight: '800'},
  subtitle: {color: colors.textSecondary, fontSize: 14, lineHeight: 20, marginTop: 5},
  visibilityRow: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 12},
  visibilityIcon: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: colors.orangeMuted},
  visibilityText: {flex: 1},
  sectionTitle: {color: colors.textPrimary, fontSize: 17, fontWeight: '800'},
  sectionText: {color: colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 3},
  label: {color: colors.textSecondary, fontSize: 12, fontWeight: '800', marginTop: 24, marginBottom: 10},
  radiusControl: {minHeight: 50, flexDirection: 'row', padding: 4, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderRadius: 8},
  radiusButton: {flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 6},
  radiusButtonActive: {backgroundColor: colors.orange},
  radiusText: {color: colors.textSecondary, fontSize: 14, fontWeight: '800'},
  radiusTextActive: {color: '#FFFFFF'},
  retryButton: {minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.orange, borderRadius: 8, marginTop: 14},
  retryText: {color: '#FFFFFF', fontSize: 14, fontWeight: '800'},
  privacyBand: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 22, borderBottomWidth: 1, borderBottomColor: colors.border},
  privacyText: {flex: 1, color: colors.textSecondary, fontSize: 13, lineHeight: 19},
  nameRow: {flexDirection: 'row', gap: 8},
  nameInput: {flex: 1, minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 14, color: colors.textPrimary, fontSize: 15},
  saveButton: {width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: colors.orange},
  resultsHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 28, marginBottom: 10},
  resultsTitle: {color: colors.textPrimary, fontSize: 18, fontWeight: '800'},
  personRow: {minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderBottomColor: colors.border},
  personAvatar: {width: 38, height: 38, borderRadius: 8, backgroundColor: colors.orangeMuted, alignItems: 'center', justifyContent: 'center'},
  personText: {flex: 1},
  personName: {color: colors.textPrimary, fontSize: 15, fontWeight: '700'},
  personDetail: {color: colors.textSecondary, fontSize: 12, marginTop: 3},
  personAction: {minHeight: 40, justifyContent: 'center', paddingHorizontal: 6},
  personActionText: {color: colors.orange, fontSize: 13, fontWeight: '800'},
  disabledText: {color: colors.textMuted},
  emptyState: {alignItems: 'center', paddingVertical: 32, paddingHorizontal: 24},
  emptyTitle: {color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginTop: 13},
  emptyText: {color: colors.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 6},
  errorText: {color: colors.error, fontSize: 13, lineHeight: 19, marginTop: 16},
  deleteButton: {minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 32, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 18},
  deleteText: {color: colors.error, fontSize: 14, fontWeight: '800'},
});
