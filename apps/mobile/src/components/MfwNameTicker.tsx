import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../i18n';
import { colors } from '../theme/colors';
import { Icon } from './Icon';

export default function MfwNameTicker({
  onDismiss,
  onPress,
}: {
  onDismiss?: () => void;
  onPress: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  const [textWidth, setTextWidth] = useState(0);
  const [visible, setVisible] = useState(true);
  const tickerCopy = `${t('mfwNames.ticker')}  ·  `;

  useEffect(() => {
    if (textWidth <= 0) return;
    progress.setValue(0);
    const animation = Animated.loop(
      Animated.timing(progress, {
        duration: Math.max(6_000, Math.round((textWidth / 40) * 1_000)),
        easing: Easing.linear,
        toValue: 1,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [progress, textWidth]);

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -textWidth],
  });

  if (!visible) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[s.safeArea, { paddingTop: insets.top }]}
    >
      <View style={s.bar}>
        <TouchableOpacity
          accessibilityLabel={t('mfwNames.claimYourAddress')}
          accessibilityRole="button"
          activeOpacity={0.82}
          onPress={onPress}
          style={s.link}
        >
          <View style={s.icon}>
            <Icon name="key" size={14} color="#FFF" />
          </View>
          <View style={s.lane}>
            <Animated.View style={[s.marqueeContent, { transform: [{ translateX }] }]}>
              <Text
                numberOfLines={1}
                onTextLayout={event => {
                  const measuredWidth = event.nativeEvent.lines[0]?.width ?? 0;
                  if (measuredWidth > 0) setTextWidth(Math.ceil(measuredWidth));
                }}
                style={s.text}
              >
                {tickerCopy}
              </Text>
              <Text numberOfLines={1} style={s.text}>{tickerCopy}</Text>
            </Animated.View>
          </View>
          <Icon name="arrow-right" size={14} color="#FFF" />
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityLabel={t('action.close')}
          accessibilityRole="button"
          activeOpacity={0.72}
          hitSlop={6}
          onPress={() => {
            setVisible(false);
            onDismiss?.();
          }}
          style={s.closeButton}
        >
          <Icon name="close" size={15} color="#FFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.bg,
    elevation: 30,
    zIndex: 30,
  },
  bar: {
    alignItems: 'center',
    backgroundColor: '#B33B16',
    borderBottomColor: '#FF6B2C',
    borderBottomWidth: 1,
    flexDirection: 'row',
    height: 36,
    paddingLeft: 10,
    paddingRight: 5,
  },
  link: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    minWidth: 0,
  },
  icon: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  lane: {
    flex: 1,
    marginHorizontal: 7,
    overflow: 'hidden',
  },
  marqueeContent: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
  },
  text: {
    color: '#FFF',
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.25,
    paddingHorizontal: 8,
  },
  closeButton: {
    alignItems: 'center',
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
});
