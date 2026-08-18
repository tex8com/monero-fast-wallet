import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '../theme/colors';
import { useI18n } from '../i18n';
import {
  loadPrivatePhoneDeviceContacts,
  requestPrivatePhoneDiscoveryConsent,
  revokePrivatePhoneDiscoveryConsent,
} from '../backend/PrivatePhoneDeviceContacts';
import {
  loadPrivatePhoneConsent,
  type PrivatePhoneConsentState,
  type PrivatePhoneSharingPolicy,
} from '../backend/PrivatePhoneConsentRegistry';
import {
  removePrivatePhoneParticipant,
  revokePrivatePhoneContact,
  sharePrivatePhoneContact,
  type PrivatePhoneSharingWallet,
} from '../backend/PrivatePhoneSharingService';
import {
  createPrivatePhoneDirectoryClient,
  type PrivatePhoneContactInspection,
} from '../backend/PrivatePhoneDirectoryClient';
import {
  requireNativeMoneroWallet,
  type PrivatePhoneDeviceContact,
  type PrivatePhoneIncomingAddressRequest,
  type PrivatePhoneParticipantStatus,
} from '../backend/NativeMoneroWallet';
import {
  createPrivatePhoneAddressRequestService,
  type CheckedPrivatePhoneAddressRequest,
} from '../backend/PrivatePhoneAddressRequests';
import { createPrivatePhoneSendPreset } from '../backend/RecipientReview';
import { useWalletState } from '../backend/WalletState';

type ContactChoice = Readonly<{
  id: string;
  contactId: string;
  displayName: string;
  e164: string;
}>;

const EMPTY_CONSENT: PrivatePhoneConsentState = {
  version: 1,
  findPeopleEnabled: false,
  sharingStatus: 'off',
  sharedContacts: [],
};

export default function PrivateContactsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { dateLocale, t } = useI18n();
  const { registeredWallet, session } = useWalletState();
  const [consent, setConsent] =
    useState<PrivatePhoneConsentState>(EMPTY_CONSENT);
  const [contacts, setContacts] = useState<
    ReadonlyArray<Readonly<PrivatePhoneDeviceContact>>
  >([]);
  const [participant, setParticipant] = useState<PrivatePhoneParticipantStatus>(
    { verified: false, expiresAt: 0 },
  );
  const [verificationPhone, setVerificationPhone] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualName, setManualName] = useState('');
  const [verificationHandle, setVerificationHandle] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [selected, setSelected] = useState<ContactChoice>();
  const [lookupResult, setLookupResult] =
    useState<PrivatePhoneContactInspection>();
  const [addressRequest, setAddressRequest] =
    useState<CheckedPrivatePhoneAddressRequest>();
  const [incomingRequests, setIncomingRequests] = useState<
    ReadonlyArray<PrivatePhoneIncomingAddressRequest>
  >([]);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();

  const native = useMemo(() => requireNativeMoneroWallet(), []);
  const addressRequests = useMemo(
    () => createPrivatePhoneAddressRequestService(native),
    [native],
  );
  const choices = useMemo<ContactChoice[]>(
    () =>
      contacts.flatMap(contact =>
        contact.e164Numbers.map(e164 => ({
          id: `${contact.contactId}\u0000${e164}`,
          contactId: contact.contactId,
          displayName: contact.displayName || e164,
          e164,
        })),
      ),
    [contacts],
  );
  const selectedSharing = selected
    ? consent.sharedContacts.find(contact => contact.e164 === selected.e164)
    : undefined;
  const sharingWallet = useMemo<PrivatePhoneSharingWallet | undefined>(() => {
    if (
      !registeredWallet ||
      !session ||
      session.registrationId !== registeredWallet.id
    ) {
      return undefined;
    }
    return {
      registrationId: registeredWallet.id,
      nativeWalletId: session.walletId,
      accountIndex: registeredWallet.accountIndex ?? session.accountIndex ?? 0,
      network: registeredWallet.network,
    };
  }, [registeredWallet, session]);

  const refresh = useCallback(async () => {
    const nextConsent = await loadPrivatePhoneConsent();
    setConsent(nextConsent);
    const status = await native.getPrivatePhoneParticipantStatus();
    setParticipant(status);
    if (nextConsent.findPeopleEnabled) {
      setContacts(await loadPrivatePhoneDeviceContacts());
    } else {
      setContacts([]);
    }
    if (status.verified) {
      const [tracked, incoming] = await Promise.all([
        addressRequests.pollTracked(),
        addressRequests.pollIncoming(),
      ]);
      setAddressRequest(tracked[0]);
      setIncomingRequests(incoming);
    } else {
      setAddressRequest(undefined);
      setIncomingRequests([]);
    }
  }, [addressRequests, native]);

  useEffect(() => {
    refresh().catch(error => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refresh]);

  const run = useCallback(
    async (key: string, operation: () => Promise<void>) => {
      if (busy) return;
      setBusy(key);
      setMessage(undefined);
      try {
        await operation();
        await refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(undefined);
      }
    },
    [busy, refresh],
  );

  const chooseManualContact = () => {
    const e164 = manualPhone.trim();
    if (!e164) return;
    setLookupResult(undefined);
    setSelected({
      id: `manual\u0000${e164}`,
      contactId: `manual:${e164}`,
      displayName: manualName.trim() || e164,
      e164,
    });
  };

  const share = (policy: Exclude<PrivatePhoneSharingPolicy, 'invisible'>) =>
    run(`share:${policy}`, async () => {
      if (!selected) return;
      if (policy === 'direct' && !sharingWallet) {
        throw new Error(t('privateContacts.walletRequired'));
      }
      await sharePrivatePhoneContact({
        contactId: selected.contactId,
        e164: selected.e164,
        policy,
        ...(sharingWallet ? { wallet: sharingWallet } : {}),
      });
    });

  const checkSelectedContact = () =>
    run('lookup', async () => {
      if (!selected) return;
      const network = session?.network ?? registeredWallet?.network;
      if (!network) {
        throw new Error(t('privateContacts.walletRequiredForSending'));
      }
      try {
        const client = await createPrivatePhoneDirectoryClient();
        const result = await client.inspectContact(selected.e164, network);
        setLookupResult(result);
        if (result.policy !== 'direct' || !result.address) {
          return;
        }
        const preset = await createPrivatePhoneSendPreset({
          flowId: await native.createSecureRandomIdentifier(
            'private-phone-send',
          ),
          phoneNumber: selected.e164,
          displayName: selected.displayName,
          network,
          address: result.address,
          issuedAt: result.issuedAt,
          expiresAt: result.expiresAt,
          sequence: result.sequence,
        });
        navigation.navigate('Send', { privatePhoneSendPreset: preset });
      } catch {
        setLookupResult(undefined);
        throw new Error(t('privateContacts.lookupUnavailable'));
      }
    });

  const requestSelectedAddress = () =>
    run('request-address', async () => {
      if (!selected) return;
      const network = session?.network ?? registeredWallet?.network;
      if (!network) {
        throw new Error(t('privateContacts.walletRequiredForSending'));
      }
      setAddressRequest(
        await addressRequests.request({
          phoneNumber: selected.e164,
          displayName: selected.displayName,
          network,
        }),
      );
    });

  const checkAddressRequestResult = () =>
    run('check-address-request', async () => {
      if (!addressRequest) return;
      const checked = (await addressRequests.pollTracked()).find(
        item =>
          item.context.requestHandle === addressRequest.context.requestHandle,
      );
      if (!checked) {
        setAddressRequest(undefined);
        return;
      }
      setAddressRequest(checked);
      if (checked.result.status === 'waiting') {
        setMessage(t('privateContacts.requestStillWaiting'));
        return;
      }
      if (checked.result.status !== 'approved') {
        await addressRequests.forget(checked.context.requestHandle);
        setAddressRequest(undefined);
        setMessage(
          checked.result.status === 'declined'
            ? t('privateContacts.requestDeclined')
            : t('privateContacts.requestExpired'),
        );
        return;
      }
      const preset = await createPrivatePhoneSendPreset({
        flowId: await native.createSecureRandomIdentifier('private-phone-send'),
        phoneNumber: checked.context.phoneNumber,
        displayName: checked.context.displayName,
        network: checked.context.network,
        address: checked.result.address,
        issuedAt: checked.result.issuedAt,
        expiresAt: checked.result.expiresAt,
        sequence: checked.result.sequence,
      });
      await addressRequests.forget(checked.context.requestHandle);
      setAddressRequest(undefined);
      navigation.navigate('Send', { privatePhoneSendPreset: preset });
    });

  const answerIncomingRequest = (
    request: PrivatePhoneIncomingAddressRequest,
    approved: boolean,
  ) =>
    run(`answer:${request.requestHandle}`, async () => {
      await addressRequests.respond({
        requestHandle: request.requestHandle,
        approved,
        ...(approved && sharingWallet
          ? {
              walletId: sharingWallet.nativeWalletId,
              accountIndex: sharingWallet.accountIndex,
            }
          : {}),
      });
      setIncomingRequests(current =>
        current.filter(item => item.requestHandle !== request.requestHandle),
      );
    });

  const sendVerificationCode = () =>
    run('send-code', async () => {
      const challenge = await native.startPrivatePhoneVerification(
        verificationPhone.trim(),
      );
      setVerificationHandle(challenge.verificationHandle);
      setVerificationCode('');
    });

  const confirmVerificationCode = () =>
    run('confirm-code', async () => {
      const result = await native.completePrivatePhoneVerification(
        verificationHandle,
        verificationCode.trim(),
      );
      setParticipant({
        verified: result.verified,
        expiresAt: result.expiresAt,
      });
      setVerificationHandle('');
      setVerificationCode('');
    });

  const renderPolicy = (
    policy: Exclude<PrivatePhoneSharingPolicy, 'invisible'>,
    title: string,
    description: string,
  ) => (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={Boolean(busy) || !participant.verified}
      onPress={() => {
        share(policy);
      }}
      style={[styles.policy, !participant.verified && styles.disabledControl]}
    >
      <Text style={styles.policyTitle}>{title}</Text>
      <Text style={styles.body}>{description}</Text>
    </TouchableOpacity>
  );

  const header = (
    <View style={styles.header}>
      <View style={styles.topRow}>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
          style={styles.back}
        >
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{t('privateContacts.title')}</Text>
          <Text style={styles.subtitle}>{t('privateContacts.subtitle')}</Text>
        </View>
      </View>

      {incomingRequests.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {t('privateContacts.incomingTitle')}
          </Text>
          <Text style={styles.body}>
            {t('privateContacts.incomingDescription')}
          </Text>
          {incomingRequests.map(request => {
            const contact = choices.find(
              choice => choice.e164 === request.phoneNumber,
            );
            return (
              <View key={request.requestHandle} style={styles.requestCard}>
                <Text style={styles.contactName}>
                  {contact?.displayName || request.phoneNumber}
                </Text>
                <Text style={styles.phone}>{request.phoneNumber}</Text>
                <Text style={styles.hint}>
                  {t('privateContacts.requestExpires', {
                    time: new Date(
                      request.expiresAt * 1_000,
                    ).toLocaleTimeString(dateLocale, {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })}
                </Text>
                <View style={styles.requestActions}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={Boolean(busy)}
                    onPress={() => {
                      answerIncomingRequest(request, false);
                    }}
                    style={[styles.secondaryButton, styles.requestAction]}
                  >
                    <Text style={styles.primaryButtonText}>
                      {t('privateContacts.declineRequest')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={Boolean(busy) || !sharingWallet}
                    onPress={() =>
                      Alert.alert(
                        t('privateContacts.approveRequest'),
                        t('privateContacts.approveRequestConfirm'),
                        [
                          { text: t('action.cancel'), style: 'cancel' },
                          {
                            text: t('privateContacts.approveRequest'),
                            onPress: () => {
                              answerIncomingRequest(request, true);
                            },
                          },
                        ],
                      )
                    }
                    style={[
                      styles.primaryButton,
                      styles.requestAction,
                      !sharingWallet && styles.disabledControl,
                    ]}
                  >
                    <Text style={styles.primaryButtonText}>
                      {t('privateContacts.approveRequest')}
                    </Text>
                  </TouchableOpacity>
                </View>
                {!sharingWallet ? (
                  <Text style={styles.hint}>
                    {t('privateContacts.walletRequired')}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {addressRequest ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {t('privateContacts.outgoingTitle')}
          </Text>
          <Text style={styles.contactName}>
            {addressRequest.context.displayName ||
              addressRequest.context.phoneNumber}
          </Text>
          <Text style={styles.body}>
            {addressRequest.result.status === 'waiting'
              ? t('privateContacts.requestSent')
              : t('privateContacts.requestAnswered')}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={Boolean(busy)}
            onPress={() => {
              checkAddressRequestResult();
            }}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>
              {t('privateContacts.checkRequest')}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>
          {t('privateContacts.findTitle')}
        </Text>
        <Text style={styles.body}>{t('privateContacts.findDescription')}</Text>
        <View style={styles.actionRow}>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={Boolean(busy)}
            onPress={() => {
              run('contacts', async () => {
                if (consent.findPeopleEnabled) {
                  await revokePrivatePhoneDiscoveryConsent();
                } else {
                  await requestPrivatePhoneDiscoveryConsent();
                }
              });
            }}
            style={[
              styles.primaryButton,
              consent.findPeopleEnabled && styles.secondaryButton,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {consent.findPeopleEnabled
                ? t('privateContacts.turnOff')
                : t('privateContacts.findOff')}
            </Text>
          </TouchableOpacity>
          {consent.findPeopleEnabled ? (
            <Text style={styles.good}>{t('privateContacts.findOn')}</Text>
          ) : null}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>
          {t('privateContacts.verifyTitle')}
        </Text>
        <Text style={styles.body}>
          {t('privateContacts.verifyDescription')}
        </Text>
        {participant.verified ? (
          <Text style={styles.good}>
            {t('privateContacts.verifiedUntil', {
              date: new Date(participant.expiresAt * 1_000).toLocaleDateString(
                dateLocale,
              ),
            })}
          </Text>
        ) : (
          <>
            <TextInput
              autoCapitalize="none"
              keyboardType="phone-pad"
              onChangeText={setVerificationPhone}
              placeholder={t('privateContacts.phonePlaceholder')}
              placeholderTextColor={colors.textSecondary}
              style={styles.input}
              value={verificationPhone}
            />
            {verificationHandle ? (
              <>
                <TextInput
                  keyboardType="number-pad"
                  onChangeText={setVerificationCode}
                  placeholder={t('privateContacts.codePlaceholder')}
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry
                  style={styles.input}
                  value={verificationCode}
                />
                <TouchableOpacity
                  disabled={Boolean(busy)}
                  onPress={() => {
                    confirmVerificationCode();
                  }}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>
                    {t('privateContacts.confirmCode')}
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                disabled={Boolean(busy)}
                onPress={() => {
                  sendVerificationCode();
                }}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>
                  {t('privateContacts.sendCode')}
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>
          {t('privateContacts.shareTitle')}
        </Text>
        <Text style={styles.body}>{t('privateContacts.shareDescription')}</Text>
        <TextInput
          onChangeText={setManualName}
          placeholder={t('privateContacts.manualName')}
          placeholderTextColor={colors.textSecondary}
          style={styles.input}
          value={manualName}
        />
        <TextInput
          autoCapitalize="none"
          keyboardType="phone-pad"
          onChangeText={setManualPhone}
          placeholder={t('privateContacts.phonePlaceholder')}
          placeholderTextColor={colors.textSecondary}
          style={styles.input}
          value={manualPhone}
        />
        <TouchableOpacity
          disabled={!manualPhone.trim() || Boolean(busy)}
          onPress={chooseManualContact}
          style={styles.secondaryButton}
        >
          <Text style={styles.primaryButtonText}>{t('action.continue')}</Text>
        </TouchableOpacity>

        {selected ? (
          <View style={styles.selectedCard}>
            <Text style={styles.contactName}>{selected.displayName}</Text>
            <Text style={styles.phone}>{selected.e164}</Text>
            {selectedSharing ? (
              <Text style={styles.good}>
                {selectedSharing.publicationStatus === 'publishing'
                  ? t('privateContacts.statusPublishing')
                  : selectedSharing.publicationStatus === 'revoking'
                  ? t('privateContacts.statusRevoking')
                  : t('privateContacts.statusActive')}
              </Text>
            ) : null}
            <View style={styles.lookupBox}>
              <Text style={styles.policyTitle}>
                {t('privateContacts.useTitle')}
              </Text>
              <Text style={styles.body}>
                {t('privateContacts.useDescription')}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={
                  Boolean(busy) || !consent.findPeopleEnabled || !selected.e164
                }
                onPress={() => {
                  checkSelectedContact();
                }}
                style={[
                  styles.primaryButton,
                  (!consent.findPeopleEnabled || Boolean(busy)) &&
                    styles.disabledControl,
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {t('privateContacts.checkPerson')}
                </Text>
              </TouchableOpacity>
              {lookupResult?.policy === 'badge' ? (
                <Text style={styles.hint}>
                  {t('privateContacts.lookupBadge')}
                </Text>
              ) : lookupResult?.policy === 'ask' ? (
                <>
                  <Text style={styles.hint}>
                    {t('privateContacts.lookupAsk')}
                  </Text>
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={Boolean(busy)}
                    onPress={() => {
                      requestSelectedAddress();
                    }}
                    style={styles.primaryButton}
                  >
                    <Text style={styles.primaryButtonText}>
                      {t('privateContacts.requestAddress')}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
            {renderPolicy(
              'badge',
              t('privateContacts.badge'),
              t('privateContacts.badgeDescription'),
            )}
            {renderPolicy(
              'ask',
              t('privateContacts.ask'),
              t('privateContacts.askDescription'),
            )}
            {renderPolicy(
              'direct',
              t('privateContacts.direct'),
              t('privateContacts.directDescription'),
            )}
            {selectedSharing ? (
              <TouchableOpacity
                disabled={Boolean(busy)}
                onPress={() => {
                  run('revoke', () => revokePrivatePhoneContact(selected.e164));
                }}
                style={styles.dangerButton}
              >
                <Text style={styles.dangerText}>
                  {t('privateContacts.stopSharing')}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
        {choices.length === 0 ? (
          <Text style={styles.hint}>{t('privateContacts.noContacts')}</Text>
        ) : null}
      </View>

      {message ? <Text style={styles.error}>{message}</Text> : null}
    </View>
  );

  const footer = (
    <View
      style={[styles.card, styles.footer, { marginBottom: insets.bottom + 40 }]}
    >
      <Text style={styles.sectionTitle}>
        {t('privateContacts.removeTitle')}
      </Text>
      <Text style={styles.body}>{t('privateContacts.removeDescription')}</Text>
      <TouchableOpacity
        disabled={Boolean(busy)}
        onPress={() =>
          Alert.alert(
            t('privateContacts.removeTitle'),
            t('privateContacts.removeDescription'),
            [
              { text: t('action.cancel'), style: 'cancel' },
              {
                text: t('privateContacts.removeAction'),
                style: 'destructive',
                onPress: () => {
                  run('remove-participant', async () => {
                    await removePrivatePhoneParticipant();
                    setParticipant({ verified: false, expiresAt: 0 });
                    setSelected(undefined);
                  });
                },
              },
            ],
          )
        }
        style={styles.dangerButton}
      >
        <Text style={styles.dangerText}>
          {t('privateContacts.removeAction')}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        contentContainerStyle={styles.content}
        data={choices}
        keyExtractor={item => item.id}
        ListFooterComponent={footer}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => {
              setLookupResult(undefined);
              setMessage(undefined);
              setSelected(item);
            }}
            style={[
              styles.contactRow,
              selected?.id === item.id && styles.contactRowSelected,
            ]}
          >
            <View>
              <Text style={styles.contactName}>{item.displayName}</Text>
              <Text style={styles.phone}>{item.e164}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.xl },
  header: { gap: spacing.md },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  back: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: { color: colors.textPrimary, fontSize: 36, lineHeight: 38 },
  titleBlock: { flex: 1, gap: spacing.xs },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  card: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  sectionTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '700' },
  body: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  hint: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  input: {
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  actionRow: { gap: spacing.sm, alignItems: 'flex-start' },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.orange,
    borderRadius: radius.sm,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: spacing.md,
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.borderLight,
    borderRadius: radius.sm,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: spacing.md,
  },
  primaryButtonText: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  good: { color: colors.success, fontSize: 13, fontWeight: '700' },
  error: { color: colors.error, fontSize: 14, lineHeight: 20 },
  selectedCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    gap: spacing.sm,
    marginTop: spacing.sm,
    padding: spacing.md,
  },
  lookupBox: {
    backgroundColor: colors.bgCardLight,
    borderColor: colors.borderLight,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  requestCard: {
    backgroundColor: colors.bgCardLight,
    borderColor: colors.borderLight,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  requestActions: { flexDirection: 'row', gap: spacing.sm },
  requestAction: { flex: 1 },
  policy: {
    backgroundColor: colors.bgCardLight,
    borderColor: colors.borderLight,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  policyTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  disabledControl: { opacity: 0.45 },
  dangerButton: {
    alignItems: 'center',
    borderColor: colors.error,
    borderRadius: radius.sm,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  dangerText: { color: colors.error, fontSize: 14, fontWeight: '700' },
  contactRow: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    padding: spacing.md,
  },
  contactRowSelected: { borderColor: colors.orange },
  contactName: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  phone: { color: colors.textMuted, fontFamily: 'monospace', fontSize: 13 },
  chevron: { color: colors.textMuted, fontSize: 26 },
  footer: { marginTop: spacing.lg },
});
