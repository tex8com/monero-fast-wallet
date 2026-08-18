import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import {
  FastWalletPushService,
  type NotificationAuthorizationStatus,
} from '../services/FastWalletPushService';

export function useNotificationAuthorization() {
  const [status, setStatus] =
    useState<NotificationAuthorizationStatus>('not_determined');

  const refresh = useCallback(async () => {
    const next =
      await FastWalletPushService.getNotificationAuthorizationStatus();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        refresh();
      }
    });
    return () => subscription.remove();
  }, [refresh]);

  return {
    authorized: status === 'authorized',
    refresh,
    status,
  };
}
