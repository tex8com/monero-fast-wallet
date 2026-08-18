import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {Camera, CameraType} from 'react-native-camera-kit';
import {
  check,
  openSettings,
  PERMISSIONS,
  request,
  RESULTS,
} from 'react-native-permissions';
import {useI18n} from '../i18n';
import {extractMoneroAddressFromQr} from '../backend/RecipientQrCode';
import {withSystemUiInterruption} from '../backend/SystemUiInterruption';
import {colors, radius, spacing} from '../theme/colors';
import {Icon} from './Icon';

type ScannerState = 'checking' | 'ready' | 'denied' | 'blocked' | 'unavailable' | 'failed';

type RecipientQrScannerProps = {
  visible: boolean;
  onClose: () => void;
  onScanned: (value: string) => void;
  parseCode?: (value: string) => string | undefined;
  title?: string;
  hint?: string;
  invalidMessage?: string;
};

function deviceCameraPermission() {
  return Platform.OS === 'ios'
    ? PERMISSIONS.IOS.CAMERA
    : PERMISSIONS.ANDROID.CAMERA;
}

export default function RecipientQrScanner({
  visible,
  onClose,
  onScanned,
  parseCode = extractMoneroAddressFromQr,
  title,
  hint,
  invalidMessage,
}: RecipientQrScannerProps) {
  const {t} = useI18n();
  const [state, setState] = useState<ScannerState>('checking');
  const [invalidCode, setInvalidCode] = useState(false);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === 'active');
  const didComplete = useRef(false);

  const resolvePermission = useCallback(async () => {
    setState('checking');
    setInvalidCode(false);
    didComplete.current = false;

    try {
      const permission = deviceCameraPermission();
      const current = await check(permission);
      if (current === RESULTS.GRANTED) {
        setState('ready');
        return;
      }
      if (current === RESULTS.UNAVAILABLE) {
        setState('unavailable');
        return;
      }
      if (current === RESULTS.BLOCKED) {
        setState('blocked');
        return;
      }

      const requested = await withSystemUiInterruption(
        'camera-permission',
        () => request(permission),
      );
      if (requested === RESULTS.GRANTED) {
        setState('ready');
      } else if (requested === RESULTS.BLOCKED) {
        setState('blocked');
      } else if (requested === RESULTS.UNAVAILABLE) {
        setState('unavailable');
      } else {
        setState('denied');
      }
    } catch {
      setState('failed');
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }
    resolvePermission();
  }, [resolvePermission, visible]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      setAppIsActive(nextState === 'active');
    });
    return () => subscription.remove();
  }, []);

  const handleReadCode = useCallback(
    (event: {nativeEvent: {codeStringValue: string}}) => {
      if (didComplete.current) {
        return;
      }

      const parsed = parseCode(event.nativeEvent.codeStringValue);
      if (!parsed) {
        setInvalidCode(true);
        return;
      }

      // Camera is unmounted by the parent immediately after this callback. The
      // ref prevents duplicate native barcode events in that small interval.
      didComplete.current = true;
      onScanned(parsed);
    },
    [onScanned, parseCode],
  );

  const message =
    state === 'unavailable'
      ? t('send.scanCameraUnavailable')
      : state === 'failed'
      ? t('send.scanFailed')
      : t('send.scanCameraDenied');
  const canOpenSettings = state === 'blocked';
  const canRetry = state === 'denied' || state === 'failed';

  return (
    <Modal
      animationType="slide"
      transparent={false}
      visible={visible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>{title ?? t('send.scanAddress')}</Text>
            <Text style={styles.subtitle}>{hint ?? t('send.scanHint')}</Text>
          </View>
          <TouchableOpacity
            accessibilityLabel={t('action.close')}
            accessibilityRole="button"
            style={styles.closeButton}
            onPress={onClose}
          >
            <Icon name="close" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>

        <View style={styles.cameraWrap}>
          {state === 'checking' ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={colors.orange} size="large" />
            </View>
          ) : state === 'ready' && appIsActive ? (
            <Camera
              style={styles.camera}
              cameraType={CameraType.Back}
              scanBarcode
              allowedBarcodeTypes={['qr']}
              scanThrottleDelay={500}
              showFrame
              frameColor={colors.orange}
              laserColor={colors.orange}
              onReadCode={handleReadCode}
              onError={() => setState('failed')}
            />
          ) : state === 'ready' ? (
            <View style={styles.centerState}>
              <Text style={styles.stateText}>
                {hint ?? t('send.scanHint')}
              </Text>
            </View>
          ) : (
            <View style={styles.centerState}>
              <Icon name="camera" size={34} color={colors.orange} />
              <Text style={styles.stateText}>{message}</Text>
              {canOpenSettings ? (
                <TouchableOpacity
                  style={styles.primaryButton}
                  accessibilityRole="button"
                  onPress={() => openSettings().catch(() => undefined)}
                >
                  <Text style={styles.primaryButtonText}>{t('send.openSettings')}</Text>
                </TouchableOpacity>
              ) : null}
              {canRetry ? (
                <TouchableOpacity
                  style={styles.secondaryButton}
                  accessibilityRole="button"
                  onPress={resolvePermission}
                >
                  <Text style={styles.secondaryButtonText}>{t('action.retry')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}
          {invalidCode && state === 'ready' ? (
            <View style={styles.invalidBanner}>
              <Text style={styles.invalidText}>
                {invalidMessage ?? t('send.scanInvalid')}
              </Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.footerHint}>{hint ?? t('send.scanHint')}</Text>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: {color: colors.textPrimary, fontSize: 22, fontWeight: '800'},
  subtitle: {color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 4, maxWidth: 290},
  closeButton: {
    alignItems: 'center',
    backgroundColor: colors.bgCardLight,
    borderRadius: radius.full,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  cameraWrap: {
    backgroundColor: '#000',
    flex: 1,
    marginHorizontal: spacing.md,
    overflow: 'hidden',
    borderRadius: radius.lg,
  },
  camera: {flex: 1},
  centerState: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  stateText: {color: colors.textSecondary, fontSize: 15, lineHeight: 22, textAlign: 'center'},
  primaryButton: {
    backgroundColor: colors.orange,
    borderRadius: radius.sm,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  primaryButtonText: {color: '#FFF', fontSize: 14, fontWeight: '800'},
  secondaryButton: {
    borderColor: colors.borderLight,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  secondaryButtonText: {color: colors.textPrimary, fontSize: 14, fontWeight: '800'},
  invalidBanner: {
    backgroundColor: 'rgba(255,68,102,0.92)',
    bottom: spacing.md,
    left: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    position: 'absolute',
    right: spacing.md,
    borderRadius: radius.sm,
  },
  invalidText: {color: '#FFF', fontSize: 13, fontWeight: '700', textAlign: 'center'},
  footerHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    textAlign: 'center',
  },
});
