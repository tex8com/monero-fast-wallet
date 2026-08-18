import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import MoneroLogo from '../components/MoneroLogo';
import { useI18n } from '../i18n';
import { requestMobilePushProviderToken } from '../services/FastWalletPushService';
import {
  type CommunityV1AccountStatus,
  type CommunityV1Chat,
  type CommunityV1Contact,
  type CommunityV1ContactRequest,
  type CommunityV1ContentDraft,
  type CommunityV1ContentModerationOutcome,
  type CommunityV1ContentRecord,
  type CommunityV1MatrixMessage,
  type CommunityV1ModerationOutcome,
  type CommunityV1QuerySuggestion,
  type CommunityV1SearchResult,
  type CommunityV1SelectedMessage,
  MoneroEnthusiastV1Service,
  runCommunityV1,
} from '../services/MoneroEnthusiastV1Service';
import {
  contributeSuccessfulCommunityQuery,
  retryPendingCommunityQueryContributions,
} from '../services/CommunityQueryContribution';
import {
  requireNativeMoneroWallet,
  type MoneroEnthusiastV1Status,
} from '../services/NativeMoneroWallet';
import { colors } from '../theme/colors';

const EMPTY_STATUS: MoneroEnthusiastV1Status = {
  packaged: false,
  ready: false,
  identityExists: false,
  catalogReady: false,
  matrixReady: false,
  reason: '',
};

function publicationStatusLabel(
  status: string,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (status.trim().toLowerCase()) {
    case 'awaiting_screening': return t('communityV1.status.awaitingScreening');
    case 'human_review': return t('communityV1.status.humanReview');
    case 'needs_changes': return t('communityV1.status.needsChanges');
    case 'quarantined': return t('communityV1.status.quarantined');
    case 'approved_awaiting_embedding': return t('communityV1.status.approvedAwaitingEmbedding');
    case 'published': return t('communityV1.status.published');
    case 'hidden': return t('communityV1.status.hidden');
    case 'rejected': return t('communityV1.status.rejected');
    case 'removed': return t('communityV1.status.removed');
    case 'expired': return t('communityV1.status.expired');
    case 'withdrawn': return t('communityV1.status.withdrawn');
    default: return t('communityV1.preparing');
  }
}

/**
 * The V1 renderer receives only public DTOs and message text the user opened.
 * Account credentials, Matrix sessions, store keys, model internals and search
 * semantic vectors remain below the native bridge.
 */
export default function MoneroEnthusiastScreen() {
  const { language, t } = useI18n();
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [account, setAccount] = useState<CommunityV1AccountStatus | null>(null);
  const [content, setContent] = useState<CommunityV1ContentRecord[]>([]);
  const [pending, setPending] = useState<CommunityV1ContactRequest[]>([]);
  const [contacts, setContacts] = useState<CommunityV1Contact[]>([]);
  const [profileName, setProfileName] = useState('');
  const [profileAbout, setProfileAbout] = useState('');
  const [productTitle, setProductTitle] = useState('');
  const [productDescription, setProductDescription] = useState('');
  const [productCategories, setProductCategories] = useState('');
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<CommunityV1QuerySuggestion[]>(
    [],
  );
  const [results, setResults] = useState<CommunityV1SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [openedResultId, setOpenedResultId] = useState<string | null>(null);
  const [contentOutcomes, setContentOutcomes] = useState<
    CommunityV1ContentModerationOutcome[]
  >([]);
  const [suspensionOutcome, setSuspensionOutcome] =
    useState<CommunityV1ModerationOutcome | null>(null);
  const [appealReason, setAppealReason] = useState('');
  const [contentAppealReason, setContentAppealReason] = useState('');
  const [chat, setChat] = useState<CommunityV1Chat | null>(null);
  const [messages, setMessages] = useState<CommunityV1MatrixMessage[]>([]);
  const [messageBody, setMessageBody] = useState('');
  const [selectedReport, setSelectedReport] =
    useState<CommunityV1SelectedMessage | null>(null);
  const [reportReason, setReportReason] = useState('');

  const profile = useMemo(
    () => content.find(item => item.draft.kind === 'profile'),
    [content],
  );
  const productListings = useMemo(
    () => content.filter(item => item.draft.kind === 'product_listing'),
    [content],
  );

  const loadPrivateData = useCallback(async () => {
    const [nextAccount, nextContent, nextPending, nextContacts, nextOutcomes] =
      await Promise.all([
        MoneroEnthusiastV1Service.accountStatus(),
        MoneroEnthusiastV1Service.listContent(),
        MoneroEnthusiastV1Service.pendingContacts(),
        MoneroEnthusiastV1Service.acceptedContacts(),
        MoneroEnthusiastV1Service.moderationOutcomes(),
      ]);
    setAccount(nextAccount);
    setContent(nextContent);
    setPending(nextPending);
    setContacts(nextContacts);
    setContentOutcomes(nextOutcomes);
    if (nextAccount.suspensionCaseId) {
      setSuspensionOutcome(
        await MoneroEnthusiastV1Service.chatReportOutcome(
          nextAccount.suspensionCaseId,
        ),
      );
    } else {
      setSuspensionOutcome(null);
    }
    const nextProfile = nextContent.find(item => item.draft.kind === 'profile');
    if (nextProfile) {
      setProfileName(nextProfile.draft.title);
      setProfileAbout(nextProfile.draft.summary);
    }
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const next =
        await requireNativeMoneroWallet().getMoneroEnthusiastV1Status();
      setStatus(next);
      setNotice(next.packaged ? null : t('communityV1.notReady'));
      if (next.identityExists && next.matrixReady) {
        await loadPrivateData();
      }
      if (next.identityExists) {
        retryPendingCommunityQueryContributions().catch(() => undefined);
      }
    } catch {
      setStatus(EMPTY_STATUS);
      setNotice(t('communityV1.notReady'));
    } finally {
      setBusy(false);
    }
  }, [loadPrivateData, t]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    const prefix = query.trim();
    if (!status.catalogReady || !prefix) {
      setSuggestions([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      MoneroEnthusiastV1Service.suggestions(prefix, language)
        .then(next => {
          if (!cancelled) {
            setSuggestions(next);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSuggestions([]);
          }
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [language, query, status.catalogReady]);

  const begin = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const next = status.identityExists
        ? await runCommunityV1<MoneroEnthusiastV1Status>('refresh')
        : await runCommunityV1<MoneroEnthusiastV1Status>('initialize');
      setStatus(next);
      if (next.identityExists && next.matrixReady) {
        await loadPrivateData();
      }
    } catch {
      setNotice(t('communityV1.openFailed'));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    if (!profileName.trim() || !profileAbout.trim()) {
      return;
    }
    setBusy(true);
    setNotice(null);
    const draft: CommunityV1ContentDraft = {
      kind: 'profile',
      title: profileName.trim(),
      summary: profileAbout.trim(),
      roles: [],
      categories: [],
      languages: [language],
      media: [],
    };
    try {
      if (profile) {
        await MoneroEnthusiastV1Service.resubmitProfile(
          profile.publicId,
          draft,
        );
      } else {
        await MoneroEnthusiastV1Service.submitProfile(draft);
      }
      setNotice(t('communityV1.profileSubmitted'));
      await loadPrivateData();
    } catch {
      setNotice(t('communityV1.profileFailed'));
    } finally {
      setBusy(false);
    }
  };

  const submitProductListing = async () => {
    if (!productTitle.trim() || !productDescription.trim()) {
      return;
    }
    const categories = Array.from(
      new Set(
        productCategories
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
      ),
    ).slice(0, 16);
    if (categories.some(value => value.length > 64)) {
      setNotice(t('communityV1.productCategoriesInvalid'));
      return;
    }
    setBusy(true);
    setNotice(null);
    const draft: CommunityV1ContentDraft = {
      kind: 'product_listing',
      title: productTitle.trim(),
      summary: productDescription.trim(),
      roles: [],
      categories,
      languages: [language],
      media: [],
    };
    try {
      await MoneroEnthusiastV1Service.submitContent(draft);
      setProductTitle('');
      setProductDescription('');
      setProductCategories('');
      setNotice(t('communityV1.productSubmitted'));
      await loadPrivateData();
    } catch {
      setNotice(t('communityV1.productFailed'));
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    if (!query.trim()) {
      return;
    }
    setBusy(true);
    setNotice(null);
    setSearched(true);
    try {
      const submittedQuery = query.trim();
      setResults(
        await MoneroEnthusiastV1Service.search(submittedQuery, language),
      );
      setSuggestions([]);
      contributeSuccessfulCommunityQuery(submittedQuery, language).catch(
        () => undefined,
      );
    } catch {
      setNotice(t('communityV1.searchFailed'));
    } finally {
      setBusy(false);
    }
  };

  const clearSearchHistory = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await MoneroEnthusiastV1Service.clearSearchHistory();
      setSuggestions([]);
      setNotice(t('communityV1.searchHistoryCleared'));
    } catch {
      setNotice(t('communityV1.searchHistoryClearFailed'));
    } finally {
      setBusy(false);
    }
  };

  const openSearchResult = (publicId: string) => {
    setOpenedResultId(publicId);
    MoneroEnthusiastV1Service.recordInterest(
      publicId,
      'content_opened',
    ).catch(() => undefined);
  };

  useEffect(() => {
    if (!openedResultId) {
      return undefined;
    }
    const timer = setTimeout(() => {
      MoneroEnthusiastV1Service.recordInterest(
        openedResultId,
        'longer_local_view',
      ).catch(() => undefined);
    }, 6_000);
    return () => clearTimeout(timer);
  }, [openedResultId]);

  const requestContact = async (peerId: string, publicId?: string) => {
    setBusy(true);
    try {
      await MoneroEnthusiastV1Service.requestContact(peerId);
      if (publicId) {
        MoneroEnthusiastV1Service.recordInterest(
          publicId,
          'contact_requested',
        ).catch(() => undefined);
      }
      setNotice(t('communityV1.requestSent'));
    } catch {
      setNotice(t('communityV1.contactFailed'));
    } finally {
      setBusy(false);
    }
  };

  const answerContact = async (requestId: string, accept: boolean) => {
    setBusy(true);
    try {
      await MoneroEnthusiastV1Service.respondContact(requestId, accept);
      await loadPrivateData();
    } catch {
      setNotice(t('communityV1.contactFailed'));
    } finally {
      setBusy(false);
    }
  };

  const openChat = async (peerId: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const opened = await MoneroEnthusiastV1Service.openChat(peerId);
      const page = await MoneroEnthusiastV1Service.messages(opened.roomId);
      setChat(opened);
      setMessages(page.messages);
    } catch {
      setNotice(t('communityV1.chatFailed'));
    } finally {
      setBusy(false);
    }
  };

  const refreshChat = async () => {
    if (!chat) {
      return;
    }
    try {
      const page = await MoneroEnthusiastV1Service.messages(chat.roomId);
      setMessages(page.messages);
    } catch {
      setNotice(t('communityV1.chatFailed'));
    }
  };

  const submitSuspensionAppeal = async () => {
    if (!account?.suspensionCaseId || !appealReason.trim()) {
      return;
    }
    setBusy(true);
    try {
      await MoneroEnthusiastV1Service.appealChatReport(
        account.suspensionCaseId,
        appealReason.trim(),
      );
      setAppealReason('');
      setNotice(t('communityV1.appealSent'));
      await loadPrivateData();
    } catch {
      setNotice(t('communityV1.appealFailed'));
    } finally {
      setBusy(false);
    }
  };

  const submitContentAppeal = async (caseId: string) => {
    if (!contentAppealReason.trim()) {
      return;
    }
    setBusy(true);
    try {
      await MoneroEnthusiastV1Service.appealContent(
        caseId,
        contentAppealReason.trim(),
      );
      setContentAppealReason('');
      setNotice(t('communityV1.appealSent'));
      await loadPrivateData();
    } catch {
      setNotice(t('communityV1.appealFailed'));
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async () => {
    if (!chat || !messageBody.trim()) {
      return;
    }
    setBusy(true);
    try {
      await MoneroEnthusiastV1Service.sendMessage(
        chat.roomId,
        messageBody.trim(),
      );
      setMessageBody('');
      await refreshChat();
    } catch {
      setNotice(t('communityV1.sendFailed'));
    } finally {
      setBusy(false);
    }
  };

  const chooseReport = async (eventId: string) => {
    if (!chat) {
      return;
    }
    try {
      const selected = await MoneroEnthusiastV1Service.reportPreview(
        chat.roomId,
        eventId,
      );
      setSelectedReport(selected);
      setReportReason('');
    } catch {
      setNotice(t('communityV1.reportFailed'));
    }
  };

  const sendReport = async () => {
    if (!chat || !selectedReport || !reportReason.trim()) {
      return;
    }
    setBusy(true);
    try {
      await MoneroEnthusiastV1Service.reportMessage(
        chat,
        selectedReport,
        reportReason.trim(),
      );
      setSelectedReport(null);
      setReportReason('');
      setNotice(t('communityV1.reportSent'));
    } catch {
      setNotice(t('communityV1.reportFailed'));
    } finally {
      setBusy(false);
    }
  };

  const confirmBlock = () => {
    if (!chat) {
      return;
    }
    Alert.alert(t('communityV1.block'), t('communityV1.blockConfirm'), [
      { text: t('action.cancel'), style: 'cancel' },
      {
        text: t('communityV1.block'),
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          MoneroEnthusiastV1Service.blockContact(chat.peerId)
            .then(loadPrivateData)
            .then(() => {
              setChat(null);
              setMessages([]);
            })
            .catch(() => setNotice(t('communityV1.blockFailed')))
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  const confirmDelete = () => {
    Alert.alert(
      t('communityV1.deleteProfile'),
      t('communityV1.deleteConfirm'),
      [
        { text: t('action.cancel'), style: 'cancel' },
        {
          text: t('communityV1.deleteProfile'),
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            MoneroEnthusiastV1Service.deleteIdentity()
              .then(() => {
                setAccount(null);
                setContent([]);
                setPending([]);
                setContacts([]);
                setResults([]);
                setSearched(false);
                setContentOutcomes([]);
                setSuspensionOutcome(null);
                setChat(null);
                return load();
              })
              .catch(() => setNotice(t('communityV1.deleteFailed')))
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  };

  const enableNotifications = async () => {
    setBusy(true);
    try {
      const registration = await requestMobilePushProviderToken();
      await MoneroEnthusiastV1Service.registerNotification(
        registration.provider,
        registration.token,
      );
      setNotice(t('communityV1.notificationsEnabled'));
    } catch {
      setNotice(t('communityV1.notificationsFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.container}>
      <ScrollView
        contentContainerStyle={s.scroll}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={busy}
            onRefresh={() => load().catch(() => undefined)}
            tintColor={colors.orange}
          />
        }
      >
        <View style={s.header}>
          <MoneroLogo size={52} />
          <View style={s.headerText}>
            <Text style={s.eyebrow}>{t('communityV1.optional')}</Text>
            <Text accessibilityRole="header" style={s.title}>
              {t('communityV1.title')}
            </Text>
            <Text style={s.subtitle}>{t('communityV1.subtitle')}</Text>
          </View>
        </View>

        <View style={s.promiseCard}>
          <Text style={s.cardTitle}>{t('communityV1.walletSeparate')}</Text>
          <Text style={s.cardText}>{t('communityV1.walletSeparateText')}</Text>
        </View>

        <View style={s.statusCard}>
          <View style={s.rowBetween}>
            <Text style={s.cardTitle}>{t('communityV1.status')}</Text>
            {busy ? (
              <ActivityIndicator color={colors.orange} />
            ) : (
              <StatusBadge ready={status.ready} />
            )}
          </View>
          <StatusRow
            label={t('communityV1.catalog')}
            ready={status.catalogReady}
          />
          <StatusRow
            label={t('communityV1.privateMessages')}
            ready={status.matrixReady}
          />
          {!status.ready ? (
            <Text style={s.cardText}>
              {notice ?? t('communityV1.notReady')}
            </Text>
          ) : null}
          {status.packaged && !status.ready ? (
            <ActionButton
              disabled={busy}
              label={
                status.identityExists
                  ? t('communityV1.openPrivateChat')
                  : t('communityV1.createProfile')
              }
              onPress={begin}
            />
          ) : null}
        </View>

        {status.identityExists && status.matrixReady ? (
          <>
            {account?.suspended ? (
              <View style={s.warningCard}>
                <Text style={s.cardTitle}>{t('communityV1.suspended')}</Text>
                <Text style={s.cardText}>{t('communityV1.suspendedText')}</Text>
                {suspensionOutcome?.decisionReason ? (
                  <Text style={s.cardText}>
                    {t('communityV1.reason')}:{' '}
                    {suspensionOutcome.decisionReason}
                  </Text>
                ) : null}
                {suspensionOutcome?.appealPending ? (
                  <Text style={s.small}>{t('communityV1.appealPending')}</Text>
                ) : (
                  <>
                    <Field
                      label={t('communityV1.appealReason')}
                      maxLength={2000}
                      multiline
                      onChangeText={setAppealReason}
                      value={appealReason}
                    />
                    <ActionButton
                      disabled={busy || !appealReason.trim()}
                      label={t('communityV1.sendAppeal')}
                      onPress={submitSuspensionAppeal}
                    />
                  </>
                )}
              </View>
            ) : null}

            <Section title={t('communityV1.publicProfile')}>
              <Text style={s.cardText}>
                {t('communityV1.publicProfileText')}
              </Text>
              <Field
                label={t('communityV1.publicName')}
                maxLength={120}
                onChangeText={setProfileName}
                value={profileName}
              />
              <Field
                label={t('communityV1.publicAbout')}
                maxLength={2000}
                multiline
                onChangeText={setProfileAbout}
                value={profileAbout}
              />
              {profile ? (
                <Text style={s.small}>
                  {t('communityV1.reviewStatus')}:{' '}
                  {publicationStatusLabel(profile.status, t)}
                </Text>
              ) : null}
              {contentOutcomes
                .filter(outcome => outcome.publicId === profile?.publicId)
                .map(outcome => (
                  <View key={outcome.caseId} style={s.outcomeCard}>
                    <Text style={s.resultTitle}>
                      {t('communityV1.moderationDecision')}
                    </Text>
                    <Text style={s.cardText}>
                      {outcome.decisionReason ??
                        t('communityV1.decisionPending')}
                    </Text>
                    {outcome.appealPending ? (
                      <Text style={s.small}>
                        {t('communityV1.appealPending')}
                      </Text>
                    ) : outcome.decision ? (
                      <>
                        <Field
                          label={t('communityV1.appealReason')}
                          maxLength={2000}
                          multiline
                          onChangeText={setContentAppealReason}
                          value={contentAppealReason}
                        />
                        <QuietButton
                          disabled={busy || !contentAppealReason.trim()}
                          label={t('communityV1.sendAppeal')}
                          onPress={() => submitContentAppeal(outcome.caseId)}
                        />
                      </>
                    ) : null}
                  </View>
                ))}
              <ActionButton
                disabled={
                  busy ||
                  account?.suspended ||
                  !profileName.trim() ||
                  !profileAbout.trim()
                }
                label={t('communityV1.submitReview')}
                onPress={saveProfile}
              />
            </Section>

            <Section title={t('communityV1.productListing')}>
              <Text style={s.cardText}>
                {t('communityV1.productListingText')}
              </Text>
              <Field
                label={t('communityV1.productTitle')}
                maxLength={120}
                onChangeText={setProductTitle}
                value={productTitle}
              />
              <Field
                label={t('communityV1.productDescription')}
                maxLength={2000}
                multiline
                onChangeText={setProductDescription}
                value={productDescription}
              />
              <Field
                autoCapitalize="none"
                label={t('communityV1.productCategories')}
                maxLength={512}
                onChangeText={setProductCategories}
                value={productCategories}
              />
              <Text style={s.small}>
                {t('communityV1.productCategoriesHint')}
              </Text>
              <ActionButton
                disabled={
                  busy ||
                  account?.suspended ||
                  !productTitle.trim() ||
                  !productDescription.trim()
                }
                label={t('communityV1.submitProduct')}
                onPress={submitProductListing}
              />
              {productListings.map(listing => (
                <View key={listing.publicId} style={s.resultCard}>
                  <Text style={s.resultTitle}>{listing.draft.title}</Text>
                  <Text style={s.cardText}>{listing.draft.summary}</Text>
                  <Text style={s.small}>
                    {t('communityV1.reviewStatus')}:{' '}
                    {publicationStatusLabel(listing.status, t)}
                  </Text>
                </View>
              ))}
            </Section>

            <Section title={t('communityV1.discover')}>
              <Field
                label={t('communityV1.searchLabel')}
                maxLength={160}
                onChangeText={setQuery}
                onSubmitEditing={search}
                value={query}
              />
              {suggestions.length > 0 ? (
                <View style={s.suggestionList}>
                  {suggestions.map(suggestion => (
                    <TouchableOpacity
                      accessibilityRole="button"
                      key={suggestion.queryId}
                      onPress={() => {
                        setQuery(suggestion.displayText);
                        setSuggestions([]);
                      }}
                      style={s.suggestionRow}
                    >
                      <Text style={s.suggestionText}>
                        {suggestion.displayText}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
              <ActionButton
                disabled={busy || !query.trim()}
                label={t('action.search')}
                onPress={search}
              />
              <QuietButton
                disabled={busy}
                label={t('communityV1.clearSearchHistory')}
                onPress={clearSearchHistory}
              />
              {results.length === 0 && searched ? (
                <Text style={s.cardText}>{t('communityV1.noResults')}</Text>
              ) : null}
              {results.map(result => (
                <View key={result.item.publicId} style={s.resultCard}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => openSearchResult(result.item.publicId)}
                  >
                    <Text style={s.resultTitle}>{result.item.title}</Text>
                    <Text
                      numberOfLines={
                        openedResultId === result.item.publicId ? undefined : 2
                      }
                      style={s.cardText}
                    >
                      {result.item.summary}
                    </Text>
                  </TouchableOpacity>
                  {result.item.ownerPublicId !== account?.identityId ? (
                    <QuietButton
                      disabled={busy}
                      label={t('communityV1.requestContact')}
                      onPress={() =>
                        requestContact(
                          result.item.ownerPublicId,
                          result.item.publicId,
                        )
                      }
                    />
                  ) : null}
                </View>
              ))}
            </Section>

            <Section title={t('communityV1.contacts')}>
              {pending.map(request => (
                <View key={request.requestId} style={s.resultCard}>
                  <Text style={s.resultTitle}>
                    {t('communityV1.contactRequest')}
                  </Text>
                  <Text style={s.small}>
                    {t('communityV1.contactRequestText')}
                  </Text>
                  <View style={s.inlineActions}>
                    <QuietButton
                      disabled={busy}
                      label={t('communityV1.decline')}
                      onPress={() => answerContact(request.requestId, false)}
                    />
                    <QuietButton
                      disabled={busy}
                      label={t('communityV1.accept')}
                      onPress={() => answerContact(request.requestId, true)}
                    />
                  </View>
                </View>
              ))}
              {contacts.length === 0 ? (
                <Text style={s.cardText}>{t('communityV1.noContacts')}</Text>
              ) : (
                contacts.map(contact => (
                  <View key={contact.peerId} style={s.resultCard}>
                    <Text style={s.resultTitle}>
                      {t('communityV1.privateContact')}
                    </Text>
                    <QuietButton
                      disabled={busy}
                      label={t('communityV1.openChat')}
                      onPress={() => openChat(contact.peerId)}
                    />
                  </View>
                ))
              )}
            </Section>

            {chat ? (
              <Section title={t('communityV1.privateConversation')}>
                <Text style={s.cardText}>{t('communityV1.chatSafety')}</Text>
                <View style={s.messageList}>
                  {messages.length === 0 ? (
                    <Text style={s.cardText}>
                      {t('communityV1.noMessages')}
                    </Text>
                  ) : (
                    messages.map(item => (
                      <View
                        key={item.eventId}
                        style={[
                          s.messageBubble,
                          item.sentByMe && s.messageBubbleOwn,
                        ]}
                      >
                        <Text style={s.messageText}>{item.body}</Text>
                        {!item.sentByMe ? (
                          <TouchableOpacity
                            accessibilityRole="button"
                            onPress={() => chooseReport(item.eventId)}
                          >
                            <Text style={s.reportLink}>
                              {t('communityV1.report')}
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    ))
                  )}
                </View>
                <Field
                  label={t('communityV1.messagePlaceholder')}
                  maxLength={4000}
                  multiline
                  onChangeText={setMessageBody}
                  value={messageBody}
                />
                <View style={s.inlineActions}>
                  <QuietButton
                    disabled={busy}
                    label={t('action.retry')}
                    onPress={refreshChat}
                  />
                  <ActionButton
                    disabled={busy || !messageBody.trim()}
                    label={t('communityV1.send')}
                    onPress={sendMessage}
                  />
                </View>
                <DangerButton
                  disabled={busy}
                  label={t('communityV1.block')}
                  onPress={confirmBlock}
                />
              </Section>
            ) : null}

            {selectedReport ? (
              <Section title={t('communityV1.reviewReport')}>
                <Text style={s.cardText}>
                  {t('communityV1.reviewReportText')}
                </Text>
                <View style={s.quote}>
                  <Text style={s.messageText}>{selectedReport.body}</Text>
                </View>
                <Field
                  label={t('communityV1.reportReason')}
                  maxLength={2000}
                  multiline
                  onChangeText={setReportReason}
                  value={reportReason}
                />
                <View style={s.inlineActions}>
                  <QuietButton
                    label={t('action.cancel')}
                    onPress={() => setSelectedReport(null)}
                  />
                  <DangerButton
                    disabled={busy || !reportReason.trim()}
                    label={t('communityV1.confirmReport')}
                    onPress={sendReport}
                  />
                </View>
              </Section>
            ) : null}

            <QuietButton
              disabled={busy}
              label={t('communityV1.enableNotifications')}
              onPress={enableNotifications}
            />
            <DangerButton
              disabled={busy}
              label={t('communityV1.deleteProfile')}
              onPress={confirmDelete}
            />
          </>
        ) : null}

        {notice && status.ready ? (
          <Text accessibilityRole="alert" style={s.notice}>
            {notice}
          </Text>
        ) : null}
        <Text style={s.safety}>{t('communityV1.safety')}</Text>
      </ScrollView>
    </View>
  );
}

function Section({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <View style={s.section}>
      <Text accessibilityRole="header" style={s.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Field({
  label,
  ...props
}: React.ComponentProps<typeof TextInput> & { label: string }) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textSecondary}
        style={[s.input, props.multiline && s.inputMultiline]}
        {...props}
      />
    </View>
  );
}

function StatusBadge({ ready }: { ready: boolean }) {
  const { t } = useI18n();
  return (
    <View style={[s.badge, ready && s.badgeReady]}>
      <Text style={[s.badgeText, ready && s.badgeReadyText]}>
        {ready ? t('communityV1.ready') : t('communityV1.preparing')}
      </Text>
    </View>
  );
}

function StatusRow({ label, ready }: { label: string; ready: boolean }) {
  const { t } = useI18n();
  return (
    <View style={s.statusRow}>
      <Text style={s.statusLabel}>{label}</Text>
      <Text style={ready ? s.statusGood : s.statusWaiting}>
        {ready ? t('communityV1.ready') : t('communityV1.preparing')}
      </Text>
    </View>
  );
}

function ActionButton({ disabled, label, onPress }: ButtonProps) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      activeOpacity={0.72}
      disabled={disabled}
      onPress={onPress}
      style={[s.button, disabled && s.disabled]}
    >
      <Text style={s.buttonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function QuietButton({ disabled, label, onPress }: ButtonProps) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      activeOpacity={0.72}
      disabled={disabled}
      onPress={onPress}
      style={[s.quietButton, disabled && s.disabled]}
    >
      <Text style={s.quietText}>{label}</Text>
    </TouchableOpacity>
  );
}

function DangerButton({ disabled, label, onPress }: ButtonProps) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      activeOpacity={0.72}
      disabled={disabled}
      onPress={onPress}
      style={[s.dangerButton, disabled && s.disabled]}
    >
      <Text style={s.dangerText}>{label}</Text>
    </TouchableOpacity>
  );
}

type ButtonProps = {
  disabled?: boolean;
  label: string;
  onPress: () => void | Promise<void>;
};

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 20, paddingBottom: 132, paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  headerText: { flex: 1 },
  eyebrow: {
    color: colors.orange,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.textPrimary,
    fontSize: 30,
    fontWeight: '800',
    marginTop: 4,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
  },
  promiseCard: {
    backgroundColor: colors.orangeMuted,
    borderColor: 'rgba(242,104,34,0.45)',
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 24,
    padding: 18,
  },
  statusCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 18,
    padding: 18,
  },
  section: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    marginTop: 18,
    padding: 18,
  },
  warningCard: {
    backgroundColor: 'rgba(255,184,0,0.1)',
    borderColor: colors.warning,
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 18,
    padding: 18,
  },
  cardTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  sectionTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '800' },
  cardText: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  small: { color: colors.textSecondary, fontSize: 11, lineHeight: 16 },
  rowBetween: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  badge: {
    backgroundColor: colors.surface,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeReady: { backgroundColor: 'rgba(0,214,143,0.14)' },
  badgeText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  badgeReadyText: { color: colors.success },
  statusRow: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  statusLabel: { color: colors.textMuted, fontSize: 13 },
  statusGood: { color: colors.success, fontSize: 12, fontWeight: '700' },
  statusWaiting: { color: colors.warning, fontSize: 12, fontWeight: '700' },
  field: { gap: 6 },
  fieldLabel: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  input: {
    backgroundColor: colors.bgInput,
    borderColor: colors.borderLight,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  inputMultiline: { minHeight: 92, textAlignVertical: 'top' },
  suggestionList: {
    backgroundColor: colors.bgInput,
    borderColor: colors.borderLight,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  suggestionRow: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  suggestionText: { color: colors.textPrimary, fontSize: 14 },
  button: {
    alignItems: 'center',
    backgroundColor: colors.orange,
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
  },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  quietButton: {
    alignItems: 'center',
    borderColor: colors.borderLight,
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
  },
  quietText: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  dangerButton: {
    alignItems: 'center',
    borderColor: colors.error,
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 46,
    paddingHorizontal: 14,
  },
  dangerText: { color: colors.error, fontSize: 13, fontWeight: '800' },
  disabled: { opacity: 0.45 },
  resultCard: {
    backgroundColor: colors.bgCardLight,
    borderRadius: 14,
    gap: 8,
    padding: 14,
  },
  outcomeCard: {
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  resultTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '800' },
  inlineActions: { flexDirection: 'row', gap: 10 },
  messageList: { gap: 8 },
  messageBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgCardLight,
    borderRadius: 14,
    gap: 6,
    maxWidth: '88%',
    padding: 12,
  },
  messageBubbleOwn: {
    alignSelf: 'flex-end',
    backgroundColor: colors.orangeMuted,
  },
  messageText: { color: colors.textPrimary, fontSize: 14, lineHeight: 20 },
  reportLink: { color: colors.warning, fontSize: 11, fontWeight: '700' },
  quote: {
    backgroundColor: colors.bgInput,
    borderLeftColor: colors.warning,
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 12,
  },
  notice: {
    color: colors.warning,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 16,
    textAlign: 'center',
  },
  safety: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 18,
    textAlign: 'center',
  },
});
