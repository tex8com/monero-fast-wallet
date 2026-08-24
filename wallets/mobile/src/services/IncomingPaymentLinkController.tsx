import React, { createContext, useContext, useEffect, useRef } from 'react';
import { Alert } from 'react-native';

import { useI18n } from '../i18n';
import {
  createPaymentLinkSendPreset,
  type IncomingPaymentIntent,
  type PaymentLinkSendPreset,
} from './IncomingPaymentLink';
import { paymentLinkClient, type PaymentLinkRecord } from './PaymentLinkClient';
import { logWalletEvent } from './WalletLogger';

export type PendingIncomingPayment = Readonly<{
  sequence: number;
  intent: IncomingPaymentIntent;
}>;

type PaymentLinkResolver = (
  requestId: string,
  signal?: AbortSignal,
) => Promise<PaymentLinkRecord>;

const IncomingPaymentLinkAcknowledgementContext = createContext<
  (flowId: string) => void
>(() => undefined);

export function IncomingPaymentLinkAcknowledgementProvider({
  children,
  onAcknowledged,
}: {
  children: React.ReactNode;
  onAcknowledged: (flowId: string) => void;
}) {
  return (
    <IncomingPaymentLinkAcknowledgementContext.Provider value={onAcknowledged}>
      {children}
    </IncomingPaymentLinkAcknowledgementContext.Provider>
  );
}

export function useIncomingPaymentLinkAcknowledgement() {
  return useContext(IncomingPaymentLinkAcknowledgementContext);
}

export function incomingPaymentFlowId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Incoming payment sequence is invalid.');
  }
  return `incoming-payment-${sequence}`;
}

export async function resolveIncomingPaymentIntent(
  pending: PendingIncomingPayment,
  resolvePaymentLink: PaymentLinkResolver = (requestId, requestSignal) =>
    paymentLinkClient.resolvePaymentLink(requestId, requestSignal),
  signal?: AbortSignal,
  nowMs = Date.now(),
): Promise<PaymentLinkSendPreset> {
  if (pending.intent.kind === 'invalid-payment-link') {
    throw new InvalidIncomingPaymentLinkError();
  }
  if (pending.intent.kind === 'monero-uri') {
    return createPaymentLinkSendPreset({
      flowId: incomingPaymentFlowId(pending.sequence),
      uri: pending.intent.uri,
      resolvedAtMs: nowMs,
    });
  }

  const record = await resolvePaymentLink(pending.intent.requestId, signal);
  return createPaymentLinkSendPreset({
    flowId: incomingPaymentFlowId(pending.sequence),
    requestId: pending.intent.requestId,
    uri: record.uri,
    resolvedAtMs: nowMs,
    expiresAtMs: record.expiresAt,
  });
}

export function IncomingPaymentLinkController({
  navigation,
  navigationReady,
  onConsumed,
  pending,
}: {
  navigation: {
    isReady(): boolean;
    navigate(screen: string, params?: Record<string, unknown>): void;
  };
  navigationReady: number;
  onConsumed: (sequence: number) => void;
  pending?: PendingIncomingPayment;
}) {
  const { t } = useI18n();
  const presentedSequenceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!pending) {
      presentedSequenceRef.current = undefined;
      return;
    }
    if (
      presentedSequenceRef.current === pending.sequence ||
      navigationReady < 1 ||
      !navigation.isReady()
    ) {
      return;
    }
    let active = true;
    const abortController = new AbortController();
    logWalletEvent('PaymentLink', 'incoming.started', {
      kind: pending.intent.kind,
    });

    resolveIncomingPaymentIntent(pending, undefined, abortController.signal)
      .then(preset => {
        if (!active || !navigation.isReady()) return;
        presentedSequenceRef.current = pending.sequence;
        navigation.navigate('Send', { paymentLinkSendPreset: preset });
        logWalletEvent('PaymentLink', 'incoming.presented', {
          kind: pending.intent.kind,
        });
      })
      .catch(error => {
        if (!active) return;
        onConsumed(pending.sequence);
        const invalid = error instanceof InvalidIncomingPaymentLinkError;
        Alert.alert(
          t('send.paymentLinkErrorTitle'),
          t(
            invalid ? 'send.paymentLinkInvalid' : 'send.paymentLinkUnavailable',
          ),
        );
        logWalletEvent('PaymentLink', 'incoming.rejected', {
          invalid,
          kind: pending.intent.kind,
        });
      });

    return () => {
      active = false;
      abortController.abort();
    };
  }, [navigation, navigationReady, onConsumed, pending, t]);

  return null;
}

class InvalidIncomingPaymentLinkError extends Error {
  constructor() {
    super('Payment link is invalid or expired.');
    this.name = 'InvalidIncomingPaymentLinkError';
  }
}
