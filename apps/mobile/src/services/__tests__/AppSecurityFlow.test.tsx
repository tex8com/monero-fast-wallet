import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  AppState,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { LanguageProvider } from '../../i18n';
import { AppSecurityProvider } from '../AppSecurity';
import { walletService } from '../WalletService';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View: NativeView } = require('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) =>
      ReactModule.createElement(NativeView, props),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

jest.mock('../../components/MoneroCoin', () => {
  const ReactModule = require('react');
  const { View: NativeView } = require('react-native');
  return {
    __esModule: true,
    default: () => ReactModule.createElement(NativeView),
  };
});

jest.mock('../../components/MoneroCoinGhost', () => {
  const ReactModule = require('react');
  const { View: NativeView } = require('react-native');
  return {
    __esModule: true,
    default: () => ReactModule.createElement(NativeView),
  };
});

jest.mock('../WalletService', () => ({
  walletService: {
    configureAppProtection: jest.fn(async () => undefined),
    getAppProtectionStatus: jest.fn(),
    getBiometricAuthStatus: jest.fn(async () => ({
      available: true,
      biometryType: 'fingerprint',
      enrolled: true,
      message: '',
      supported: true,
    })),
    lockApp: jest.fn(async () => undefined),
    recordAppUserActivity: jest.fn(async () => undefined),
    setAppAutoLockSeconds: jest.fn(async () => undefined),
    unlockApp: jest.fn(async () => ({
      biometryType: 'fingerprint',
      message: '',
      success: true,
    })),
  },
}));

jest.mock('../SystemUiInterruption', () => ({
  activeSystemUiInterruptionDeadlineMs: jest.fn(() => undefined),
  recentlyCompletedSystemUiInterruption: jest.fn(() => false),
  withSystemUiInterruption: jest.fn(
    (_reason: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

const mockedWalletService = walletService as jest.Mocked<typeof walletService>;

function visibleText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(Infinity)
    .filter(value => typeof value === 'string')
    .join(' ');
}

function buttonWithText(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
) {
  const button = renderer.root.findAllByType(TouchableOpacity).find(node =>
    node
      .findAllByType(Text)
      .some(textNode =>
        textNode.props.children?.toString().includes(label),
      ),
  );
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

describe('AppSecurityProvider onboarding and unlock flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'active',
    });
  });

  it('shows Welcome before the one-time protection choice', async () => {
    mockedWalletService.getAppProtectionStatus.mockResolvedValue({
      configured: false,
      locked: true,
      mode: 'password',
    });
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <AppSecurityProvider>
            <View testID="protected-wallet-content" />
          </AppSecurityProvider>
        </LanguageProvider>,
      );
    });

    expect(visibleText(renderer!)).toContain('Monero');
    expect(visibleText(renderer!)).toContain('Fast Wallet');
    expect(visibleText(renderer!)).toContain(
      'Private, fast, and in your control.',
    );
    expect(visibleText(renderer!)).not.toContain('App protection');
    expect(
      renderer!.root.findAllByProps({ testID: 'protected-wallet-content' }),
    ).toHaveLength(0);

    await ReactTestRenderer.act(async () => {
      buttonWithText(renderer!, 'Get Started').props.onPress();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(visibleText(renderer!)).toContain('Protect your wallet');
    expect(visibleText(renderer!)).toContain('Use password instead');
    expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0);
    expect(
      renderer!.root.findAllByProps({ testID: 'protected-wallet-content' }),
    ).toHaveLength(0);

    await ReactTestRenderer.act(async () => {
      buttonWithText(renderer!, 'Use password instead').props.onPress();
    });
    const passwordInputs = renderer!.root.findAllByType(TextInput);
    expect(passwordInputs).toHaveLength(2);

    await ReactTestRenderer.act(async () => {
      passwordInputs[0].props.onChangeText('correct horse battery');
      passwordInputs[1].props.onChangeText('correct horse battery');
    });
    await ReactTestRenderer.act(async () => {
      await buttonWithText(renderer!, 'Save protection').props.onPress();
    });

    expect(mockedWalletService.configureAppProtection).toHaveBeenCalledWith(
      'password',
      'correct horse battery',
    );
    expect(
      renderer!.root.findAllByProps({ testID: 'protected-wallet-content' }),
    ).not.toHaveLength(0);
  });

  it('shows only the configured password method on later starts', async () => {
    mockedWalletService.getAppProtectionStatus.mockResolvedValue({
      configured: true,
      locked: true,
      mode: 'password',
    });
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <AppSecurityProvider>
            <View testID="protected-wallet-content" />
          </AppSecurityProvider>
        </LanguageProvider>,
      );
    });

    const text = visibleText(renderer!);
    expect(text).toContain('Unlock app');
    expect(text).not.toContain('Use fingerprint instead');
    expect(text).not.toContain('Use one simple check to open all your wallets');
    expect(renderer!.root.findAllByType(TextInput)).toHaveLength(1);
  });

  it('locks native wallet sessions before the first biometric prompt', async () => {
    mockedWalletService.getAppProtectionStatus.mockResolvedValue({
      configured: false,
      locked: true,
      mode: 'password',
    });
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <AppSecurityProvider>
            <View testID="protected-wallet-content" />
          </AppSecurityProvider>
        </LanguageProvider>,
      );
    });
    await ReactTestRenderer.act(async () => {
      buttonWithText(renderer!, 'Get Started').props.onPress();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(visibleText(renderer!)).toContain('Use password instead');
    expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0);
    await ReactTestRenderer.act(async () => {
      await renderer!.root
        .findByProps({ testID: 'app-security-primary' })
        .props.onPress();
    });

    expect(mockedWalletService.configureAppProtection).toHaveBeenCalledWith(
      'biometric',
      '',
    );
    expect(mockedWalletService.lockApp).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.unlockApp).toHaveBeenCalledTimes(1);
  });

  it('automatically requests only the configured biometric method later', async () => {
    mockedWalletService.getAppProtectionStatus.mockResolvedValue({
      configured: true,
      locked: true,
      mode: 'biometric',
    });
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <AppSecurityProvider>
            <View testID="protected-wallet-content" />
          </AppSecurityProvider>
        </LanguageProvider>,
      );
    });

    expect(mockedWalletService.unlockApp).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.configureAppProtection).not.toHaveBeenCalled();
    expect(visibleText(renderer!)).not.toContain(
      'Use one simple check to open all your wallets',
    );
    expect(visibleText(renderer!)).not.toContain('Use password instead');
    expect(
      renderer!.root.findAllByProps({ testID: 'protected-wallet-content' }),
    ).not.toHaveLength(0);
  });

  it('shows the native security delay after a wrong app password', async () => {
    mockedWalletService.getAppProtectionStatus.mockResolvedValue({
      configured: true,
      locked: true,
      mode: 'password',
    });
    mockedWalletService.unlockApp.mockResolvedValueOnce({
      biometryType: 'none',
      failedPasswordAttempts: 1,
      message: 'Incorrect app password. Try again in 2 seconds.',
      resetTriggered: false,
      success: false,
    });
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <AppSecurityProvider>
            <View testID="protected-wallet-content" />
          </AppSecurityProvider>
        </LanguageProvider>,
      );
    });
    const passwordInput = renderer!.root.findByType(TextInput);
    await ReactTestRenderer.act(async () => {
      passwordInput.props.onChangeText('wrong password');
    });
    await ReactTestRenderer.act(async () => {
      await buttonWithText(renderer!, 'Unlock app').props.onPress();
    });

    expect(visibleText(renderer!)).toContain(
      'Try again in 2 seconds.',
    );
  });

  it('continues rate limiting without a destructive final attempt', async () => {
    mockedWalletService.getAppProtectionStatus.mockResolvedValue({
      configured: true,
      locked: true,
      mode: 'password',
    });
    mockedWalletService.unlockApp.mockResolvedValueOnce({
      biometryType: 'none',
      failedPasswordAttempts: 3,
      message: 'Incorrect app password. Try again in 30 seconds.',
      resetTriggered: false,
      success: false,
    });
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <AppSecurityProvider>
            <View testID="protected-wallet-content" />
          </AppSecurityProvider>
        </LanguageProvider>,
      );
    });
    const passwordInput = renderer!.root.findByType(TextInput);
    await ReactTestRenderer.act(async () => {
      passwordInput.props.onChangeText('wrong password');
    });
    await ReactTestRenderer.act(async () => {
      await buttonWithText(renderer!, 'Unlock app').props.onPress();
    });

    expect(visibleText(renderer!)).toContain(
      'Try again in 30 seconds.',
    );
    expect(visibleText(renderer!)).not.toContain('erased');
  });

  it('never enters a destructive reset state after three failures', async () => {
    mockedWalletService.getAppProtectionStatus.mockResolvedValue({
      configured: true,
      locked: true,
      mode: 'password',
    });
    mockedWalletService.unlockApp.mockResolvedValueOnce({
      biometryType: 'none',
      failedPasswordAttempts: 3,
      message: 'Incorrect app password. Try again in 30 seconds.',
      resetTriggered: false,
      success: false,
    });
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <AppSecurityProvider>
            <View testID="protected-wallet-content" />
          </AppSecurityProvider>
        </LanguageProvider>,
      );
    });
    const passwordInput = renderer!.root.findByType(TextInput);
    await ReactTestRenderer.act(async () => {
      passwordInput.props.onChangeText('wrong password');
    });
    await ReactTestRenderer.act(async () => {
      await buttonWithText(renderer!, 'Unlock app').props.onPress();
    });

    expect(visibleText(renderer!)).toContain(
      'Try again in 30 seconds.',
    );
    expect(visibleText(renderer!)).not.toContain('erased');
    expect(
      renderer!.root.findAllByProps({ testID: 'protected-wallet-content' }),
    ).toHaveLength(0);
  });
});
