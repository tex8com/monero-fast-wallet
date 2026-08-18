import React, {useCallback, useEffect, useState} from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Icon} from '../components/Icon';
import {useI18n} from '../i18n';
import {
  blockCommunityProfile,
  getCommunityIdentityId,
  listCommunityMessages,
  reportCommunityProfile,
  sendCommunityMessage,
  type CommunityMessage,
  type CommunityProfile,
} from '../backend/EnthusiastDiscoveryService';
import {colors, spacing} from '../theme/colors';

export default function EnthusiastChatScreen({navigation, route}: any) {
  const insets = useSafeAreaInsets();
  const {t} = useI18n();
  const peer = route.params?.peer as CommunityProfile;
  const [ownId, setOwnId] = useState<string>();
  const [messages, setMessages] = useState<CommunityMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const reload = useCallback(async () => {
    const [identityId, nextMessages] = await Promise.all([
      getCommunityIdentityId(),
      listCommunityMessages(peer.identityId),
    ]);
    setOwnId(identityId);
    setMessages(nextMessages);
  }, [peer.identityId]);

  useEffect(() => {
    reload().catch(() => undefined);
    const timer = setInterval(() => reload().catch(() => undefined), 5_000);
    return () => clearInterval(timer);
  }, [reload]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) {
      return;
    }
    setSending(true);
    setDraft('');
    try {
      const message = await sendCommunityMessage(peer.identityId, body);
      setMessages(current => [...current, message]);
    } finally {
      setSending(false);
    }
  };

  const showSafety = () => {
    Alert.alert(t('enthusiasts.safety'), peer.displayName, [
      {text: t('action.cancel'), style: 'cancel'},
      {
        text: t('enthusiasts.report'),
        onPress: () =>
          reportCommunityProfile(peer.identityId, 'Reported from mobile chat').catch(
            () => undefined,
          ),
      },
      {
        text: t('enthusiasts.block'),
        style: 'destructive',
        onPress: () =>
          blockCommunityProfile(peer.identityId)
            .then(() => navigation.navigate('FindEnthusiasts'))
            .catch(() => undefined),
      },
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.iconButton} onPress={() => navigation.goBack()}>
          <Icon name="arrow-left" size={21} color={colors.textSecondary} />
        </TouchableOpacity>
        <View style={s.headerText}>
          <Text style={s.title}>{peer.displayName}</Text>
          <Text style={s.subtitle}>{t('enthusiasts.acceptedContact')}</Text>
        </View>
        <TouchableOpacity style={s.safetyButton} onPress={showSafety}>
          <Text style={s.safetyText}>{t('enthusiasts.safety')}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={s.messages}
        contentContainerStyle={s.messageContent}
        showsVerticalScrollIndicator={false}>
        {messages.length === 0 ? (
          <Text style={s.empty}>{t('enthusiasts.chatEmpty')}</Text>
        ) : (
          messages.map(message => {
            const mine = message.senderId === ownId;
            return (
              <View key={message.id} style={[s.messageRow, mine && s.messageRowMine]}>
                <View style={[s.bubble, mine && s.bubbleMine]}>
                  <Text style={s.messageText}>{message.body}</Text>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      <View style={[s.composer, {paddingBottom: Math.max(insets.bottom, 10)}]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          style={s.input}
          placeholder={t('enthusiasts.messagePlaceholder')}
          placeholderTextColor={colors.textMuted}
          maxLength={1000}
          multiline
        />
        <TouchableOpacity style={s.sendButton} onPress={send} disabled={sending}>
          <Icon name="send" size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  header: {minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: spacing.lg, paddingBottom: 10, paddingTop: 10, borderBottomWidth: 1, borderBottomColor: colors.border},
  iconButton: {width: 40, height: 40, alignItems: 'center', justifyContent: 'center'},
  headerText: {flex: 1},
  title: {color: colors.textPrimary, fontSize: 18, fontWeight: '800'},
  subtitle: {color: colors.textSecondary, fontSize: 12, marginTop: 2},
  safetyButton: {minHeight: 40, justifyContent: 'center'},
  safetyText: {color: colors.textSecondary, fontSize: 13, fontWeight: '700'},
  messages: {flex: 1},
  messageContent: {paddingHorizontal: spacing.lg, paddingVertical: 18},
  empty: {color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 40},
  messageRow: {alignItems: 'flex-start', marginBottom: 10},
  messageRowMine: {alignItems: 'flex-end'},
  bubble: {maxWidth: '82%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border},
  bubbleMine: {backgroundColor: colors.orangeMuted, borderColor: colors.orange},
  messageText: {color: colors.textPrimary, fontSize: 15, lineHeight: 20},
  composer: {flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: spacing.lg, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border},
  input: {flex: 1, minHeight: 46, maxHeight: 110, borderWidth: 1, borderColor: colors.border, borderRadius: 8, color: colors.textPrimary, paddingHorizontal: 13, paddingVertical: 11, fontSize: 15},
  sendButton: {width: 46, height: 46, borderRadius: 8, backgroundColor: colors.orange, alignItems: 'center', justifyContent: 'center'},
});
