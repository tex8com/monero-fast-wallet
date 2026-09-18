import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Alert, Text, TextInput, TouchableOpacity } from 'react-native';

import { LanguageProvider } from '../../i18n';
import { AppSecurityProvider } from '../../services/AppSecurity';
import { walletService } from '../../services/WalletService';
import SettingsScreen from '../SettingsScreen';
import NodeStatusScreen from '../NodeStatusScreen';
import mobileAppVersion from '../../../../../config/mobile-app-version.json';

jest.mock('@react-native-async-storage/async-storage', () => {
  const storage = new Map<string, string>();

  return {
    __esModule: true,
    default: {
      clear: jest.fn(async () => {
        storage.clear();
      }),
      getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
    },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

jest.mock('../../services/NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => ({
    deleteDaemonPassword: jest.fn(async () => undefined),
    getPublicBlockSpoolPreferenceMiB: jest.fn(async () => 1024),
    setPublicBlockSpoolPreferenceMiB: jest.fn(async () => undefined),
    storeDaemonPassword: jest.fn(async () => undefined),
  }),
}));

jest.mock('../../services/WalletDiagnostics', () => ({
  runWalletDiagnostics: jest.fn(async () => ({
    daemon: {
      getInfo: { ok: true, height: 1 },
      jsonRpcGetInfo: { ok: true, height: 1 },
    },
    ledgerTransport: undefined,
    native: { linkedWithMonero: true },
    settings: undefined,
    wallet: undefined,
  })),
}));

jest.mock('../../services/DerivationPerformance', () => {
  const cachedResult = {
    schemaVersion: 1,
    cpuArchitecture: 'arm64-v8a',
    neonCapable: true,
    cpuWorkers: 9,
    cpu: {
      available: true,
      verified: true,
      derivationsPerSecond: 77962,
      sampleCount: 12288,
      elapsedMs: 158,
      error: '',
    },
    metal: {
      available: false,
      verified: false,
      derivationsPerSecond: 0,
      sampleCount: 0,
      elapsedMs: 0,
      error: 'unavailable',
    },
    cuda: {
      available: false,
      verified: false,
      derivationsPerSecond: 0,
      sampleCount: 0,
      elapsedMs: 0,
      error: 'unavailable',
    },
  };
  const measuredResult = {
    ...cachedResult,
    cpu: { ...cachedResult.cpu, sampleCount: 779620, elapsedMs: 10000 },
  };
  return {
    loadCachedDerivationPerformance: jest.fn(async () => cachedResult),
    loadDerivationPerformance: jest.fn(async () => cachedResult),
    measureDerivationPerformance: jest.fn(async () => measuredResult),
  };
});

jest.mock('../../services/WalletService', () => ({
  walletService: {
    applyNodeConnectionToActive: jest.fn(async () => true),
    configureAppProtection: jest.fn(async () => undefined),
    getAppProtectionStatus: jest.fn(async () => ({
      configured: true,
      locked: false,
      mode: 'password',
    })),
    getBiometricAuthStatus: jest.fn(async () => ({
      available: true,
      biometryType: 'fingerprint',
      enrolled: true,
      message: '',
      supported: true,
    })),
    lockApp: jest.fn(async () => undefined),
    recordAppUserActivity: jest.fn(async () => undefined),
    refreshFastReceiveRegistrationStatusesForSettings: jest.fn(
      async () => undefined,
    ),
    setAppAutoLockSeconds: jest.fn(async () => undefined),
  },
}));

const mockedWalletService = walletService as jest.Mocked<typeof walletService>;

jest.mock('../../services/WalletState', () => ({
  useWalletState: () => ({
    lockWallet: jest.fn(async () => undefined),
    session: undefined,
  }),
}));

describe('SettingsScreen', () => {
  const renderers: ReactTestRenderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await ReactTestRenderer.act(async () => {
      renderers.splice(0).forEach(renderer => renderer.unmount());
    });
    jest.restoreAllMocks();
  });

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

  async function renderSettings() {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <AppSecurityProvider>
            <SettingsScreen />
          </AppSecurityProvider>
        </LanguageProvider>,
      );
    });
    renderers.push(renderer!);
    return renderer!;
  }

  async function renderNodeStatus() {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <NodeStatusScreen navigation={{goBack: jest.fn()}} />
        </LanguageProvider>,
      );
    });
    renderers.push(renderer!);
    return renderer!;
  }

  it('shows separate editable Tor daemon and Clearnet sync fields on Node Status', async () => {
    const renderer = await renderNodeStatus();

    const placeholders = renderer.root
      .findAllByType(TextInput)
      .map(input => input.props.placeholder);

    expect(placeholders).toContain('node-address.onion:18089');
    expect(placeholders).toContain('xmr.tex8.com:18091');
  });

  it('shows both Clearnet and both Onion node addresses on Node Status', async () => {
    const renderer = await renderNodeStatus();
    const labels = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children?.toString());

    expect(labels).toContain('xmr.tex8.com:18091');
    expect(labels).toContain('199.30.65.42:18091');
    expect(labels).toContain(
      'fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion:18089',
    );
    expect(labels).toContain(
      'quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion:18089',
    );
  });

  it('selects global Clearnet sync and Tor daemon routes independently', async () => {
    const renderer = await renderNodeStatus();
    const nodeChoices = () => renderer.root.findAllByType(TouchableOpacity);
    const choice = (labelPart: string) => {
      const result = nodeChoices().find(node =>
        node.props.accessibilityLabel?.includes(labelPart),
      );
      expect(result).toBeDefined();
      return result!;
    };

    await ReactTestRenderer.act(async () => {
      choice('Community Node, Clearnet').props.onPress();
    });

    expect(
      choice('Community Node, Clearnet').props.accessibilityState.selected,
    ).toBe(true);
    expect(
      choice('TEX8 Node, Onion').props.accessibilityState.selected,
    ).toBe(true);
    expect(
      choice('Community Node, Onion').props.accessibilityState.selected,
    ).toBe(false);
  });

  it('shows the shared app version in the settings footer', async () => {
    const renderer = await renderSettings();
    const labels = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children?.toString());
    expect(labels).toContain(
      `Monero Fast Wallet · v${mobileAppVersion.versionName}`,
    );
  });

  it('shows the measured CPU rate and separate unavailable GPU backends', async () => {
    const renderer = await renderSettings();
    const labels = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children?.toString());
    expect(labels).toContain('77,962 derivations/s');
    expect(labels).toContain('CPU · NEON');
    expect(labels).toContain('Metal');
    expect(labels).toContain('CUDA');
  });

  it('changes an existing app password from Settings', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const renderer = await renderSettings();
    const inputs = renderer.root.findAllByType(TextInput);
    const password = inputs.find(
      input => input.props.placeholder === 'Set app password',
    );
    const confirmation = inputs.find(
      input => input.props.placeholder === 'Confirm app password',
    );
    expect(password).toBeDefined();
    expect(confirmation).toBeDefined();

    await ReactTestRenderer.act(async () => {
      password!.props.onChangeText('replacement password');
      confirmation!.props.onChangeText('replacement password');
    });
    await ReactTestRenderer.act(async () => {
      await buttonWithText(renderer, 'Save protection').props.onPress();
    });

    expect(alert).toHaveBeenLastCalledWith(
      'Protect your wallet',
      'App protection saved.',
    );
    expect(mockedWalletService.configureAppProtection).toHaveBeenCalledWith(
      'password',
      'replacement password',
    );
  });

  it('switches an existing password configuration to biometrics from Settings', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const renderer = await renderSettings();

    await ReactTestRenderer.act(async () => {
      buttonWithText(renderer, 'Biometrics').props.onPress();
    });
    const inputs = renderer.root.findAllByType(TextInput);
    const password = inputs.find(input => input.props.placeholder === 'Set app password');
    const confirmation = inputs.find(input => input.props.placeholder === 'Confirm app password');
    await ReactTestRenderer.act(async () => {
      password!.props.onChangeText('biometric recovery password');
      confirmation!.props.onChangeText('biometric recovery password');
    });
    await ReactTestRenderer.act(async () => {
      await buttonWithText(renderer, 'Save protection').props.onPress();
    });

    // A React Native alert would cover Android's native biometric prompt and
    // make the automatic first unlock fail. The operating-system prompt is the
    // only success UI for this mode switch.
    expect(alert).not.toHaveBeenCalled();
    expect(mockedWalletService.getBiometricAuthStatus).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.configureAppProtection).toHaveBeenCalledWith(
      'biometric',
      'biometric recovery password',
    );
    expect(mockedWalletService.lockApp).toHaveBeenCalledTimes(1);
  });
});
