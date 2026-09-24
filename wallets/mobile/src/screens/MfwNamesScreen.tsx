import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

import { Icon } from '../components/Icon';
import LedgerSigningModal from '../components/LedgerSigningModal';
import WalletSelector, {
  type WalletOption,
} from '../components/WalletSelector';
import { useI18n } from '../i18n';
import {
  checkConfiguredMfwNameAvailability,
  type MfwNameAvailability,
} from '../services/MfwNameAvailabilityService';
import {
  createWalletAddressRecord,
  loadWalletAddresses,
  upsertWalletAddress,
  type WalletAddressRecord,
} from '../services/WalletAddressRegistry';
import { configuredMfwNameGenesis } from '../services/MfwNameGenesisConfig';
import {
  discoverConfiguredMfwNamesForAddresses,
  resolveConfiguredMfwOwnedNameForImport,
  resolveConfiguredMfwNameTransitionPredecessor,
  resolveConfiguredMfwOwnedNameFinalization,
} from '../services/MfwNameResolutionService';
import {
  canonicalMfwName,
  createMfwNameRegistrationDraft,
  MFW_NAME_MAX_TERM_YEARS,
  MFW_NAME_MIN_CONFIRMATIONS,
  MFW_NAME_PROTOCOL_YEAR_BLOCKS,
  mfwNameRegistrationFeeAtomic,
  type MfwNameSendPreset,
} from '../services/MfwNameRegistration';
import {
  LedgerSigningCancelledError,
  isLedgerSigningCancelledError,
  type LedgerSigningProgress,
} from '../services/LedgerSigningFlow';
import {
  applyMfwNameBroadcast,
  estimateMfwNameExpiryTimestampMs,
  effectiveMfwOwnedNameStage,
  loadMfwOwnedNames,
  mfwNameRemainingDays,
  reconcileMfwNameTransactionState,
  upsertMfwOwnedName,
  type MfwNameBroadcastResult,
  type MfwOwnedNameRecord,
} from '../services/MfwNameRegistrationRegistry';
import { logWalletEvent } from '../services/WalletLogger';
import { walletDisplayName } from '../services/WalletRegistry';
import { formatAtomicXmr } from '../services/WalletFormat';
import { walletService, type WalletSession } from '../services/WalletService';
import { useWalletState } from '../services/WalletState';
import { colors, radius, spacing } from '../theme/colors';
import { v1ReleaseFeatures } from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';

const TERM_OPTIONS = [1, 3, 5, 10] as const;
const AVAILABILITY_DEBOUNCE_MS = 500;
type AddressInputMode = 'wallet' | 'manual';
type RegistrationStep = 1 | 2 | 3;

type AvailabilityPresentation =
  | { state: 'idle' | 'checking' | 'invalid' | 'unavailable' }
  | { state: 'ready'; value: MfwNameAvailability; checkedAtMs: number };

function shortAddress(value: string) {
  if (value.length <= 24) {
    return value;
  }
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export default function MfwNamesScreen({ navigation, route }: any) {
  const { dateLocale, t } = useI18n();
  const {
    connectLedgerForSigning,
    isRegisteredWalletOpen,
    openRegisteredWalletById,
    restoreLedgerViewAfterSigning,
    registeredWallet,
    registeredWallets,
    session,
    setActiveRegisteredWallet,
    snapshot,
    walletSnapshots,
  } = useWalletState();
  const [name, setName] = useState('');
  const [yearsInput, setYearsInput] = useState('1');
  const [registrationStep, setRegistrationStep] = useState<RegistrationStep>(1);
  const [addresses, setAddresses] = useState<WalletAddressRecord[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<
    string | undefined
  >();
  const [addressInputMode, setAddressInputMode] =
    useState<AddressInputMode>('wallet');
  const [manualAddress, setManualAddress] = useState('');
  const [loadingAddresses, setLoadingAddresses] = useState(false);
  const [creatingAddress, setCreatingAddress] = useState(false);
  const [ownedNames, setOwnedNames] = useState<MfwOwnedNameRecord[]>([]);
  const [showAllOwnedNames, setShowAllOwnedNames] = useState(false);
  const [selectedOwnedNameId, setSelectedOwnedNameId] = useState<
    string | undefined
  >();
  const [loadingOwnedNames, setLoadingOwnedNames] = useState(true);
  const [renewingNameId, setRenewingNameId] = useState<string | undefined>();
  const [updatingNameId, setUpdatingNameId] = useState<string | undefined>();
  const [preparingNameId, setPreparingNameId] = useState<string | undefined>();
  const [creatingRegistration, setCreatingRegistration] = useState(false);
  const [importingRecovery, setImportingRecovery] = useState(false);
  const [recoveryName, setRecoveryName] = useState('');
  const [availability, setAvailability] = useState<AvailabilityPresentation>({
    state: 'idle',
  });
  const [message, setMessage] = useState<string | undefined>();
  const [ledgerSigningProgress, setLedgerSigningProgress] = useState<
    LedgerSigningProgress | undefined
  >();
  const ledgerSigningCancelledRef = useRef(false);
  const reverseDiscoveryKeyRef = useRef<string | undefined>(undefined);

  useEffect(
    () => () => {
      ledgerSigningCancelledRef.current = true;
    },
    [],
  );

  const prepareWithSigningSession = async <T,>(
    prepare: (signingSession: WalletSession) => Promise<T>,
  ): Promise<T> => {
    if (!session) {
      throw new Error(t('mfwNames.openWalletFirst'));
    }

    ledgerSigningCancelledRef.current = false;
    const ensureNotCancelled = () => {
      if (ledgerSigningCancelledRef.current) {
        throw new LedgerSigningCancelledError();
      }
    };
    const publishProgress = (progress: LedgerSigningProgress) => {
      if (!ledgerSigningCancelledRef.current) {
        setLedgerSigningProgress(progress);
      }
    };
    let hardwareStatusTimer: ReturnType<typeof setInterval> | undefined;
    let ledgerHandoffCreated = false;
    try {
      let signingSession: WalletSession | undefined = session;
      if (session.readOnly) {
        setLedgerSigningProgress({ phase: 'searching' });
        signingSession = await connectLedgerForSigning({
          isCancelled: () => ledgerSigningCancelledRef.current,
          onProgress: publishProgress,
        });
        ensureNotCancelled();
        ledgerHandoffCreated = Boolean(
          signingSession && !signingSession.readOnly,
        );
      }
      if (!signingSession) {
        throw new Error(t('mfwNames.openWalletFirst'));
      }
      if (signingSession.hardwareDevice) {
        ensureNotCancelled();
        publishProgress({ phase: 'preparing-request' });
        hardwareStatusTimer = setInterval(() => {
          walletService
            .getHardwareWalletStatus(signingSession)
            .then(status => {
              if (
                !ledgerSigningCancelledRef.current &&
                status.requiresUserAction
              ) {
                publishProgress({ phase: 'awaiting-confirmation' });
              }
            })
            .catch(() => undefined);
        }, 500);
      }
      const prepared = await prepare(signingSession);
      ensureNotCancelled();
      return prepared;
    } catch (error) {
      if (ledgerHandoffCreated) {
        await restoreLedgerViewAfterSigning().catch(() => false);
      }
      throw error;
    } finally {
      if (hardwareStatusTimer) {
        clearInterval(hardwareStatusTimer);
      }
      setLedgerSigningProgress(undefined);
    }
  };

  const walletSnapshotMap = useMemo(
    () => ({
      ...walletSnapshots,
      ...(registeredWallet && snapshot
        ? { [registeredWallet.id]: snapshot }
        : {}),
    }),
    [registeredWallet, snapshot, walletSnapshots],
  );
  const genesis = configuredMfwNameGenesis(
    registeredWallet?.network ?? 'mainnet',
  );
  const maxYears = genesis?.maximumTermYears ?? MFW_NAME_MAX_TERM_YEARS;
  const visibleTerms = TERM_OPTIONS.filter(term => term <= maxYears);
  const years = Number(yearsInput);
  const yearsValid =
    /^\d+$/.test(yearsInput) &&
    Number.isSafeInteger(years) &&
    years >= 1 &&
    years <= maxYears;
  const selectedAddress =
    addresses.find(address => address.id === selectedAddressId) ?? addresses[0];
  const enteredAddress =
    addressInputMode === 'manual'
      ? manualAddress.trim()
      : selectedAddress?.address ?? '';
  const renewingName = ownedNames.find(record => record.id === renewingNameId);
  const updatingName = ownedNames.find(record => record.id === updatingNameId);
  const selectedOwnedName = ownedNames.find(
    record => record.id === selectedOwnedNameId,
  );
  const recentOwnedNames = useMemo(
    () =>
      [...ownedNames]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 3),
    [ownedNames],
  );
  const visibleOwnedNames = showAllOwnedNames
    ? [...ownedNames].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )
    : recentOwnedNames;
  const feeAtomic = yearsValid ? mfwNameRegistrationFeeAtomic(years) : 0n;
  const feeXmr = formatAtomicXmr(feeAtomic.toString(), {
    maxFractionDigits: 2,
    minFractionDigits: 2,
  });
  const availabilityExpiryTimestampMs =
    availability.state === 'ready'
      ? estimateMfwNameExpiryTimestampMs(
          availability.value.expiryHeight,
          availability.value.chainTipHeight,
          availability.checkedAtMs,
        )
      : undefined;
  const availabilityHasExpiry =
    availability.state === 'ready' &&
    availability.value.expiryHeight !== undefined;
  const availabilityIsExpired =
    availability.state === 'ready' &&
    availability.value.expiryHeight !== undefined &&
    availability.value.expiryHeight <= availability.value.chainTipHeight;
  const formatDateTime = (timestampMs: number) =>
    new Intl.DateTimeFormat(dateLocale, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestampMs));
  const formatHeight = (height: number) =>
    new Intl.NumberFormat(dateLocale).format(height);
  const stageLabel = (stage: MfwOwnedNameRecord['stage']) => {
    switch (stage) {
      case 'commit-pending':
        return t('mfwNames.statusCommitPending');
      case 'reveal-ready':
        return t('mfwNames.statusRevealReady');
      case 'claim-pending':
        return t('mfwNames.statusClaimPending');
      case 'active':
        return t('mfwNames.statusActive');
      case 'update-pending':
        return t('mfwNames.statusUpdatePending');
      case 'renew-pending':
        return t('mfwNames.statusRenewPending');
      case 'revoke-pending':
        return t('mfwNames.statusRevokePending');
      case 'expired':
        return t('mfwNames.statusExpired');
      case 'revoked':
        return t('mfwNames.statusRevoked');
      case 'failed':
        return t('mfwNames.statusFailed');
    }
  };

  useEffect(() => {
    setAddressInputMode('wallet');
    setManualAddress('');
  }, [registeredWallet?.id]);

  useEffect(() => {
    let mounted = true;
    const wallet = registeredWallet;
    if (!wallet) {
      setAddresses([]);
      setSelectedAddressId(undefined);
      return () => {
        mounted = false;
      };
    }

    setLoadingAddresses(true);
    const primaryAddress = walletSnapshotMap[wallet.id]?.primaryAddress;
    const load = async () => {
      if (primaryAddress) {
        await upsertWalletAddress(
          createWalletAddressRecord({
            walletId: wallet.id,
            accountIndex: wallet.accountIndex ?? 0,
            addressIndex: wallet.addressIndex ?? 0,
            address: primaryAddress,
            label: t('mfwNames.primaryAddress'),
          }),
        );
      }
      return loadWalletAddresses(wallet.id);
    };
    load()
      .then(next => {
        if (!mounted) {
          return;
        }
        setAddresses(next);
        setSelectedAddressId(current =>
          current && next.some(address => address.id === current)
            ? current
            : next[0]?.id,
        );
      })
      .catch(() => {
        if (mounted) {
          setMessage(t('mfwNames.addressLoadFailed'));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoadingAddresses(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [registeredWallet, t, walletSnapshotMap]);

  useEffect(() => {
    let mounted = true;
    setLoadingOwnedNames(true);
    const load = async () => {
      let records = await loadMfwOwnedNames();
      const broadcast = parseMfwNameBroadcast(
        route?.params?.mfwNameBroadcast as unknown,
      );
      if (broadcast) {
        const target = records.find(
          record => record.id === broadcast.registrationId,
        );
        if (target) {
          records = await upsertMfwOwnedName(
            applyMfwNameBroadcast(target, broadcast),
          );
        }
      }
      return records;
    };
    load()
      .then(records => {
        if (mounted) {
          setOwnedNames(records);
        }
      })
      .catch(() => {
        if (mounted) {
          setMessage(t('mfwNames.namesLoadFailed'));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoadingOwnedNames(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [route?.params?.mfwNameBroadcast, t]);

  useEffect(() => {
    const wallet = registeredWallet;
    if (
      !wallet ||
      loadingAddresses ||
      loadingOwnedNames ||
      addresses.length === 0
    ) {
      return;
    }
    const discoveryKey = `${wallet.id}:${wallet.network}:${addresses
      .map(record => record.address)
      .sort()
      .join(',')}`;
    if (reverseDiscoveryKeyRef.current === discoveryKey) {
      return;
    }
    reverseDiscoveryKeyRef.current = discoveryKey;
    let active = true;
    discoverConfiguredMfwNamesForAddresses({
      addresses: addresses.map(record => record.address),
      network: wallet.network,
    })
      .then(async discovered => {
        if (!active || discovered.length === 0) {
          return;
        }
        let records = await loadMfwOwnedNames();
        const now = new Date().toISOString();
        for (const { resolution, address } of discovered) {
          const existing = records.find(
            record =>
              record.walletRegistrationId === wallet.id &&
              record.network === wallet.network &&
              record.canonicalName === resolution.canonicalName,
          );
          if (existing && existing.ownerAuthority !== 'recovery-required') {
            continue;
          }
          const addressRecord = addresses.find(
            candidate => candidate.address === address,
          );
          records = await upsertMfwOwnedName({
            version: 1,
            id:
              existing?.id ??
              `mfw-discovered:${wallet.id}:${resolution.sourceTxidHex}`,
            canonicalName: resolution.canonicalName,
            walletRegistrationId: wallet.id,
            walletAddressId:
              addressRecord?.id ?? `mfw-discovered:${resolution.sourceTxidHex}`,
            address,
            network: wallet.network,
            stage: 'active',
            termYears: Math.max(
              1,
              Math.ceil(
                (resolution.expiryHeight - resolution.recordHeight) /
                  MFW_NAME_PROTOCOL_YEAR_BLOCKS,
              ),
            ),
            sequence: resolution.sequence,
            ownerAuthority: 'recovery-required',
            ownerPublicKeyHex: resolution.ownerPublicKeyHex,
            sourceTxidHex: resolution.sourceTxidHex,
            expiryHeight: resolution.expiryHeight,
            lastChainTipHeight: resolution.chainTipHeight,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          });
        }
        if (active) {
          setOwnedNames(records);
        }
      })
      .catch(error => {
        reverseDiscoveryKeyRef.current = undefined;
        logWalletEvent('MfwNameRegistry', 'reverse-discovery.failed', {
          failure:
            error instanceof Error ? error.name : 'unknown-reverse-failure',
          walletKind: wallet.kind,
        });
      });
    return () => {
      active = false;
    };
  }, [addresses, loadingAddresses, loadingOwnedNames, registeredWallet]);

  useEffect(() => {
    let active = true;
    if (!session || !registeredWallet || !genesis || ownedNames.length === 0) {
      return () => {
        active = false;
      };
    }
    const commitCandidates = ownedNames.filter(
      record =>
        record.walletRegistrationId === registeredWallet.id &&
        record.stage === 'commit-pending' &&
        record.commitTxidHex,
    );
    const finalizationCandidates = ownedNames.filter(
      record =>
        record.walletRegistrationId === registeredWallet.id &&
        (record.stage === 'claim-pending' ||
          record.stage === 'update-pending' ||
          record.stage === 'renew-pending' ||
          record.stage === 'revoke-pending') &&
        record.sourceTxidHex &&
        record.ownerPublicKeyHex,
    );
    if (commitCandidates.length === 0 && finalizationCandidates.length === 0) {
      return () => {
        active = false;
      };
    }
    walletService
      .getTransactions(session, 100)
      .then(async transactions => {
        let next = ownedNames;
        for (const record of commitCandidates) {
          const reconciled = reconcileMfwNameTransactionState(
            record,
            transactions,
            genesis.commitMaturityBlocks,
            genesis.commitRevealWindowBlocks,
          );
          if (reconciled !== record) {
            next = await upsertMfwOwnedName(reconciled);
          }
        }
        for (const record of finalizationCandidates) {
          const transaction = transactions.find(
            candidate => candidate.hash.toLowerCase() === record.sourceTxidHex,
          );
          if (!transaction || transaction.pending) {
            continue;
          }
          if (transaction.failed) {
            next = await upsertMfwOwnedName({
              ...record,
              stage: record.stage === 'claim-pending' ? 'failed' : 'active',
              pendingAddress: undefined,
              sourceTxidHex:
                record.stage === 'claim-pending'
                  ? record.sourceTxidHex
                  : undefined,
              updatedAt: new Date().toISOString(),
            });
            continue;
          }
          if (transaction.confirmations < MFW_NAME_MIN_CONFIRMATIONS) {
            continue;
          }
          const resolution = await resolveConfiguredMfwOwnedNameFinalization({
            name: record.canonicalName,
            network: record.network,
            expectedAddress:
              record.stage === 'update-pending'
                ? record.pendingAddress ?? ''
                : record.address,
            expectedOwnerPublicKeyHex: record.ownerPublicKeyHex!,
            expectedSourceTxidHex: record.sourceTxidHex!,
            expectedSequence:
              record.stage === 'claim-pending' ? 0 : record.sequence + 1,
            expectedStatus:
              record.stage === 'revoke-pending' ? 'revoked' : 'finalized',
          });
          next = await upsertMfwOwnedName({
            ...record,
            address:
              record.stage === 'update-pending'
                ? record.pendingAddress!
                : record.address,
            stage: record.stage === 'revoke-pending' ? 'revoked' : 'active',
            sequence: resolution.sequence,
            expiryHeight: resolution.expiryHeight,
            lastChainTipHeight: resolution.chainTipHeight,
            pendingAddress: undefined,
            updatedAt: new Date().toISOString(),
          });
        }
        if (active) {
          setOwnedNames(next);
        }
      })
      .catch(() => {
        // A wallet refresh can race a close/reopen. The next synchronized
        // snapshot retries without mutating the registration state.
      });
    return () => {
      active = false;
    };
  }, [genesis, ownedNames, registeredWallet, session, snapshot?.daemonHeight]);

  useEffect(() => {
    let active = true;
    if (renewingName || updatingName || !name.trim()) {
      setAvailability({ state: 'idle' });
      return () => {
        active = false;
      };
    }

    try {
      canonicalMfwName(name);
    } catch {
      setAvailability({ state: 'invalid' });
      return () => {
        active = false;
      };
    }
    if (!v1ReleaseFeatures.mfwNameRegistration) {
      setAvailability({ state: 'unavailable' });
      return () => {
        active = false;
      };
    }

    setAvailability({ state: 'checking' });
    const timer = setTimeout(() => {
      checkConfiguredMfwNameAvailability({
        name,
        // Availability is public registry data. It must also work before a
        // wallet is opened (or directly after a clean development install).
        network: registeredWallet?.network ?? 'mainnet',
      })
        .then(value => {
          if (active) {
            setAvailability({ state: 'ready', value, checkedAtMs: Date.now() });
          }
        })
        .catch(() => {
          if (active) {
            setAvailability({ state: 'unavailable' });
          }
        });
    }, AVAILABILITY_DEBOUNCE_MS);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [name, registeredWallet?.network, renewingName, updatingName]);

  const selectWallet = async (wallet: WalletOption) => {
    setMessage(undefined);
    if (isRegisteredWalletOpen(wallet.id)) {
      if (wallet.id !== registeredWallet?.id) {
        await setActiveRegisteredWallet(wallet.id);
      }
      return;
    }

    const opened = await openRegisteredWalletById(wallet.id);
    if (!opened) {
      setMessage(t('mfwNames.openWalletFirst'));
    }
  };

  const createDedicatedAddress = async () => {
    if (!session || !registeredWallet) {
      setMessage(t('mfwNames.openWalletFirst'));
      return;
    }
    if (session.registrationId !== registeredWallet.id) {
      setMessage(t('mfwNames.openSelectedWallet'));
      return;
    }
    setCreatingAddress(true);
    setMessage(undefined);
    try {
      const address = await walletService.createSubaddress(
        session,
        t('mfwNames.subaddressLabel', {
          name: name.trim() || 'MFW',
        }),
      );
      const next = await loadWalletAddresses(registeredWallet.id);
      setAddresses(next);
      setSelectedAddressId(address.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingAddress(false);
    }
  };

  const continueToRegistration = async () => {
    setMessage(undefined);
    if (!registeredWallet || !session) {
      setMessage(t('mfwNames.openWalletFirst'));
      return;
    }
    if (!enteredAddress) {
      setMessage(t('mfwNames.chooseAddress'));
      return;
    }
    if (!yearsValid) {
      setMessage(t('mfwNames.termRange', { max: maxYears }));
      return;
    }
    try {
      canonicalMfwName(name);
    } catch {
      setMessage(t('mfwNames.invalidName'));
      return;
    }
    if (!genesis) {
      setMessage(t('mfwNames.activationPending'));
      return;
    }
    if (
      availability.state !== 'ready' ||
      availability.value.status !== 'available'
    ) {
      setMessage(t('mfwNames.availabilityRequired'));
      return;
    }

    setCreatingRegistration(true);
    try {
      const validatedAddress = await walletService.validateRecipientAddress(
        enteredAddress,
        registeredWallet.network,
      );
      const draft = createMfwNameRegistrationDraft({
        walletRegistrationId: registeredWallet.id,
        walletAddressId:
          addressInputMode === 'manual'
            ? `mfw-manual:${Date.now()}`
            : selectedAddress!.id,
        address: validatedAddress,
        network: registeredWallet.network,
        name,
        years,
        maximumTermYears: genesis.maximumTermYears,
      });
      const prepared = await prepareWithSigningSession(signingSession =>
        walletService.prepareMfwNameRegistration(signingSession, {
          registrationId: draft.id,
          name: draft.name,
          address: draft.address,
          network: draft.network,
          registryAddress: genesis.registryAddress,
          priority: 'low',
        }),
      );
      const recoveryExported = await walletService.exportMfwNameRecovery(
        draft.id,
        draft.name,
        draft.network,
      );
      if (!recoveryExported) {
        throw new Error(t('mfwNames.recoveryRequired'));
      }
      const recoveryExportedAt = new Date().toISOString();
      const record: MfwOwnedNameRecord = {
        version: 1,
        id: draft.id,
        canonicalName: draft.name,
        walletRegistrationId: draft.walletRegistrationId,
        walletAddressId: draft.walletAddressId,
        address: draft.address,
        network: draft.network,
        stage: 'commit-pending',
        termYears: draft.years,
        sequence: 0,
        ownerAuthority: 'local',
        ownerPublicKeyHex: prepared.ownerPublicKeyHex,
        recoveryExportedAt,
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
      };
      setOwnedNames(await upsertMfwOwnedName(record));
      openMfwNameApproval({
        version: 1,
        flowId: `${draft.id}:commit:${prepared.preparedTransaction.id}`,
        registrationId: draft.id,
        walletRegistrationId: draft.walletRegistrationId,
        name: draft.name,
        years: draft.years,
        kind: 'commit',
        destinationAddress: genesis.registryAddress,
        preparedTransaction: prepared.preparedTransaction,
      });
    } catch (error) {
      if (!isLedgerSigningCancelledError(error)) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setCreatingRegistration(false);
    }
  };

  const advanceRegistration = () => {
    setMessage(undefined);
    if (registrationStep === 1) {
      try {
        canonicalMfwName(name);
      } catch {
        setMessage(t('mfwNames.invalidName'));
        return;
      }
      if (!genesis) {
        setMessage(t('mfwNames.activationPending'));
        return;
      }
      if (
        availability.state !== 'ready' ||
        availability.value.status !== 'available'
      ) {
        setMessage(t('mfwNames.availabilityRequired'));
        return;
      }
      setRegistrationStep(2);
      return;
    }
    if (registrationStep === 2) {
      if (!registeredWallet || !session) {
        setMessage(t('mfwNames.openWalletFirst'));
        return;
      }
      if (session.registrationId !== registeredWallet.id) {
        setMessage(t('mfwNames.openSelectedWallet'));
        return;
      }
      if (!enteredAddress) {
        setMessage(t('mfwNames.chooseAddress'));
        return;
      }
      if (!yearsValid) {
        setMessage(t('mfwNames.termRange', { max: maxYears }));
        return;
      }
      setRegistrationStep(3);
      return;
    }
    continueToRegistration();
  };

  const openMfwNameApproval = (preset: MfwNameSendPreset) => {
    navigation.navigate('Send', { mfwNameSendPreset: preset });
  };

  const continueClaim = async (record: MfwOwnedNameRecord) => {
    if (!registeredWallet || !session || !genesis) {
      setMessage(t('mfwNames.openWalletFirst'));
      return;
    }
    if (
      registeredWallet.id !== record.walletRegistrationId ||
      session.registrationId !== record.walletRegistrationId ||
      registeredWallet.network !== record.network
    ) {
      setMessage(t('mfwNames.openSelectedWallet'));
      return;
    }
    setPreparingNameId(record.id);
    setMessage(undefined);
    try {
      const prepared = await prepareWithSigningSession(signingSession =>
        walletService.prepareMfwNameClaim(signingSession, {
          registrationId: record.id,
          name: record.canonicalName,
          address: record.address,
          network: record.network,
          registryAddress: genesis.registryAddress,
          years: record.termYears,
          priority: 'low',
        }),
      );
      openMfwNameApproval({
        version: 1,
        flowId: `${record.id}:claim:${prepared.preparedTransaction.id}`,
        registrationId: record.id,
        walletRegistrationId: record.walletRegistrationId,
        name: record.canonicalName,
        years: record.termYears,
        kind: 'claim',
        destinationAddress: genesis.registryAddress,
        preparedTransaction: prepared.preparedTransaction,
      });
    } catch (error) {
      if (!isLedgerSigningCancelledError(error)) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setPreparingNameId(undefined);
    }
  };

  const beginRenewal = async (record: MfwOwnedNameRecord) => {
    if (
      !registeredWallets.some(
        wallet => wallet.id === record.walletRegistrationId,
      )
    ) {
      setMessage(t('mfwNames.walletNoLongerAvailable'));
      return;
    }
    const chainTip =
      walletSnapshotMap[record.walletRegistrationId]?.daemonHeight ??
      record.lastChainTipHeight;
    if (
      chainTip === undefined ||
      record.expiryHeight === undefined ||
      !record.ownerPublicKeyHex ||
      effectiveMfwOwnedNameStage({
        ...record,
        lastChainTipHeight: chainTip,
      }) !== 'active'
    ) {
      setMessage(t('mfwNames.expiredFreshClaim'));
      return;
    }
    if (registeredWallet?.id !== record.walletRegistrationId) {
      await setActiveRegisteredWallet(record.walletRegistrationId);
    }
    setUpdatingNameId(undefined);
    setRenewingNameId(record.id);
    setYearsInput('1');
    setMessage(undefined);
    if (!isRegisteredWalletOpen(record.walletRegistrationId)) {
      await openRegisteredWalletById(record.walletRegistrationId);
    }
  };

  const beginAddressUpdate = async (record: MfwOwnedNameRecord) => {
    if (
      !registeredWallets.some(
        wallet => wallet.id === record.walletRegistrationId,
      )
    ) {
      setMessage(t('mfwNames.walletNoLongerAvailable'));
      return;
    }
    if (registeredWallet?.id !== record.walletRegistrationId) {
      setAddresses([]);
      setSelectedAddressId(undefined);
      await setActiveRegisteredWallet(record.walletRegistrationId);
    } else {
      setSelectedAddressId(
        addresses.find(address => address.address !== record.address)?.id,
      );
    }
    setAddressInputMode('wallet');
    setManualAddress('');
    setRenewingNameId(undefined);
    setUpdatingNameId(record.id);
    setMessage(undefined);
    if (!isRegisteredWalletOpen(record.walletRegistrationId)) {
      await openRegisteredWalletById(record.walletRegistrationId);
    }
  };

  const restartRegistration = async (record: MfwOwnedNameRecord) => {
    if (
      !registeredWallets.some(
        wallet => wallet.id === record.walletRegistrationId,
      )
    ) {
      setMessage(t('mfwNames.walletNoLongerAvailable'));
      return;
    }
    if (registeredWallet?.id !== record.walletRegistrationId) {
      await setActiveRegisteredWallet(record.walletRegistrationId);
    }
    setRenewingNameId(undefined);
    setUpdatingNameId(undefined);
    setName(record.canonicalName.replace(/\.mfw$/i, ''));
    setYearsInput('1');
    setRegistrationStep(1);
    setMessage(undefined);
  };

  const continueRenewal = async () => {
    if (!renewingName || !registeredWallet || !session) {
      setMessage(t('mfwNames.openWalletFirst'));
      return;
    }
    if (
      registeredWallet.id !== renewingName.walletRegistrationId ||
      session.registrationId !== renewingName.walletRegistrationId ||
      registeredWallet.network !== renewingName.network
    ) {
      setMessage(t('mfwNames.openSelectedWallet'));
      return;
    }
    if (!genesis) {
      setMessage(t('mfwNames.activationPending'));
      return;
    }
    if (!yearsValid) {
      setMessage(t('mfwNames.termRange', { max: maxYears }));
      return;
    }
    await prepareOwnedNameTransition(
      renewingName,
      'renew',
      renewingName.address,
      years,
    );
  };

  const continueAddressUpdate = async () => {
    if (!updatingName || !registeredWallet) {
      setMessage(t('mfwNames.chooseNewAddress'));
      return;
    }
    if (
      addressInputMode === 'wallet' &&
      (!selectedAddress ||
        selectedAddress.walletId !== updatingName.walletRegistrationId)
    ) {
      setMessage(t('mfwNames.chooseNewAddress'));
      return;
    }
    if (!enteredAddress) {
      setMessage(t('mfwNames.chooseNewAddress'));
      return;
    }
    let validatedAddress: string;
    try {
      validatedAddress = await walletService.validateRecipientAddress(
        enteredAddress,
        updatingName.network,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : t('mfwNames.invalidAddress'),
      );
      return;
    }
    if (validatedAddress === updatingName.address) {
      setMessage(t('mfwNames.chooseDifferentAddress'));
      return;
    }
    await prepareOwnedNameTransition(
      updatingName,
      'update',
      validatedAddress,
      updatingName.termYears,
    );
  };

  const continueRevocation = async (record: MfwOwnedNameRecord) => {
    await prepareOwnedNameTransition(
      record,
      'revoke',
      record.address,
      record.termYears,
    );
  };

  const prepareOwnedNameTransition = async (
    record: MfwOwnedNameRecord,
    operation: 'update' | 'renew' | 'revoke',
    nextAddress: string,
    operationYears: number,
  ) => {
    if (!registeredWallet || !session || !genesis) {
      setMessage(t('mfwNames.openWalletFirst'));
      return;
    }
    if (
      registeredWallet.id !== record.walletRegistrationId ||
      session.registrationId !== record.walletRegistrationId ||
      registeredWallet.network !== record.network
    ) {
      setMessage(t('mfwNames.openSelectedWallet'));
      return;
    }
    if (!record.ownerPublicKeyHex) {
      setMessage(t('mfwNames.expiredFreshClaim'));
      return;
    }
    setPreparingNameId(record.id);
    setMessage(undefined);
    try {
      const predecessor = await resolveConfiguredMfwNameTransitionPredecessor({
        name: record.canonicalName,
        network: record.network,
        expectedOwnerPublicKeyHex: record.ownerPublicKeyHex,
      });
      const prepared = await prepareWithSigningSession(signingSession =>
        walletService.prepareMfwNameTransition(signingSession, {
          registrationId: record.id,
          operation,
          name: record.canonicalName,
          address: nextAddress,
          network: record.network,
          registryAddress: genesis.registryAddress,
          years: operationYears,
          predecessorRecordHex: predecessor.recordPayloadHex,
          predecessorSigningOwnerPublicKeyHex:
            predecessor.signingOwnerPublicKeyHex,
          priority: 'low',
        }),
      );
      if (operation === 'update') {
        setOwnedNames(
          await upsertMfwOwnedName({
            ...record,
            pendingAddress: nextAddress,
            updatedAt: new Date().toISOString(),
          }),
        );
      }
      openMfwNameApproval({
        version: 1,
        flowId: `${record.id}:${operation}:${prepared.preparedTransaction.id}`,
        registrationId: record.id,
        walletRegistrationId: record.walletRegistrationId,
        name: record.canonicalName,
        years: operationYears,
        kind: operation,
        destinationAddress:
          operation === 'renew' ? genesis.registryAddress : nextAddress,
        preparedTransaction: prepared.preparedTransaction,
      });
    } catch (error) {
      if (!isLedgerSigningCancelledError(error)) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setPreparingNameId(undefined);
    }
  };

  const importOwnerRecovery = async () => {
    if (!registeredWallet) {
      setMessage(t('mfwNames.openWalletFirst'));
      return;
    }
    let canonicalName: string;
    try {
      canonicalName = canonicalMfwName(recoveryName);
    } catch {
      setMessage(t('mfwNames.invalidName'));
      return;
    }
    setPreparingNameId('mfw-recovery-import');
    setMessage(undefined);
    try {
      const { resolution, address } =
        await resolveConfiguredMfwOwnedNameForImport({
          name: canonicalName,
          network: registeredWallet.network,
        });
      const now = new Date().toISOString();
      const existingRecord = ownedNames.find(
        record =>
          record.canonicalName === canonicalName &&
          record.network === registeredWallet.network,
      );
      const registrationId =
        existingRecord?.id ??
        `mfw-recovered:${registeredWallet.id}:` +
          `${canonicalName}:${resolution.sourceTxidHex}`;
      const ownerPublicKeyHex = await walletService.importMfwNameRecovery(
        registrationId,
        canonicalName,
        address,
        registeredWallet.network,
        resolution.ownerPublicKeyHex,
      );
      if (!ownerPublicKeyHex) {
        return;
      }
      const estimatedTermYears = Math.max(
        1,
        Math.ceil(
          (resolution.expiryHeight - resolution.recordHeight) /
            MFW_NAME_PROTOCOL_YEAR_BLOCKS,
        ),
      );
      setOwnedNames(
        await upsertMfwOwnedName({
          version: 1,
          id: registrationId,
          canonicalName,
          walletRegistrationId: registeredWallet.id,
          walletAddressId: `mfw-recovered:${resolution.sourceTxidHex}`,
          address,
          network: registeredWallet.network,
          stage: 'active',
          termYears: estimatedTermYears,
          sequence: resolution.sequence,
          ownerAuthority: 'local',
          ownerPublicKeyHex,
          sourceTxidHex: resolution.sourceTxidHex,
          expiryHeight: resolution.expiryHeight,
          lastChainTipHeight: resolution.chainTipHeight,
          recoveryExportedAt: now,
          createdAt: existingRecord?.createdAt ?? now,
          updatedAt: now,
        }),
      );
      setImportingRecovery(false);
      setRecoveryName('');
      setMessage(t('mfwNames.recoveryImported'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingNameId(undefined);
    }
  };

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        {selectedOwnedName &&
        !renewingName &&
        !updatingName &&
        !importingRecovery ? (
          <>
            <TouchableOpacity
              accessibilityRole="button"
              style={s.back}
              onPress={() => {
                setSelectedOwnedNameId(undefined);
                setMessage(undefined);
              }}
            >
              <Icon name="arrow-left" size={20} color={colors.textSecondary} />
              <Text style={s.backText}>{t('action.back')}</Text>
            </TouchableOpacity>
            <View style={s.ownedNameList}>
              {[selectedOwnedName].map(record => {
                const chainTip =
                  walletSnapshotMap[record.walletRegistrationId]
                    ?.daemonHeight ?? record.lastChainTipHeight;
                const stage = effectiveMfwOwnedNameStage({
                  ...record,
                  lastChainTipHeight: chainTip,
                });
                const remainingDays = mfwNameRemainingDays(
                  record.expiryHeight,
                  chainTip,
                );
                const wallet = registeredWallets.find(
                  candidate => candidate.id === record.walletRegistrationId,
                );
                const renewable =
                  stage === 'active' &&
                  record.ownerAuthority !== 'recovery-required';
                const canClaim = stage === 'reveal-ready';
                const canRestart = stage === 'expired' || stage === 'revoked';

                return (
                  <View key={record.id} style={s.ownedNameCard}>
                    <View style={s.ownedNameHeader}>
                      <View style={s.ownedNameCopy}>
                        <Text style={s.ownedName}>{record.canonicalName}</Text>
                        <Text style={s.ownedNameWallet}>
                          {wallet
                            ? walletDisplayName(wallet)
                            : t('mfwNames.unknownWallet')}
                          {' · '}
                          {record.network}
                        </Text>
                      </View>
                      <View
                        style={[
                          s.stageBadge,
                          stage === 'active' && s.stageBadgeActive,
                          (stage === 'expired' ||
                            stage === 'revoked' ||
                            stage === 'failed') &&
                            s.stageBadgeProblem,
                        ]}
                      >
                        <Text
                          style={[
                            s.stageText,
                            stage === 'active' && s.stageTextActive,
                            (stage === 'expired' ||
                              stage === 'revoked' ||
                              stage === 'failed') &&
                              s.stageTextProblem,
                          ]}
                        >
                          {stageLabel(stage)}
                        </Text>
                      </View>
                    </View>
                    <Text style={s.ownedNameAddress}>
                      {shortAddress(record.address)}
                    </Text>
                    <View style={s.nameMetrics}>
                      <View style={s.nameMetric}>
                        <Text style={s.nameMetricLabel}>
                          {t('mfwNames.registeredTerm')}
                        </Text>
                        <Text style={s.nameMetricValue}>
                          {record.termYears}{' '}
                          {record.termYears === 1
                            ? t('mfwNames.year')
                            : t('mfwNames.years')}
                        </Text>
                      </View>
                      <View style={s.nameMetric}>
                        <Text style={s.nameMetricLabel}>
                          {t('mfwNames.expiresAtBlock')}
                        </Text>
                        <Text style={s.nameMetricValue}>
                          {record.expiryHeight ?? '—'}
                        </Text>
                      </View>
                      <View style={s.nameMetric}>
                        <Text style={s.nameMetricLabel}>
                          {t('mfwNames.daysRemaining')}
                        </Text>
                        <Text style={s.nameMetricValue}>
                          {remainingDays === undefined
                            ? '—'
                            : t('mfwNames.daysValue', {
                                count: remainingDays,
                              })}
                        </Text>
                      </View>
                    </View>
                    <Text style={s.expiryHint}>
                      {t('mfwNames.expiryEstimate')}
                    </Text>
                    {canClaim ? (
                      <TouchableOpacity
                        accessibilityRole="button"
                        style={s.nameAction}
                        disabled={preparingNameId === record.id}
                        onPress={() => continueClaim(record)}
                      >
                        {preparingNameId === record.id ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.orange}
                          />
                        ) : (
                          <Icon
                            name="arrow-right"
                            size={16}
                            color={colors.orange}
                          />
                        )}
                        <Text style={s.nameActionText}>
                          {t('mfwNames.claimTitle')}
                        </Text>
                      </TouchableOpacity>
                    ) : renewable ? (
                      <View style={s.nameActionRow}>
                        <TouchableOpacity
                          accessibilityRole="button"
                          style={s.nameAction}
                          onPress={() => beginAddressUpdate(record)}
                        >
                          <Icon name="edit" size={16} color={colors.orange} />
                          <Text style={s.nameActionText}>
                            {t('mfwNames.changeAddress')}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          accessibilityRole="button"
                          style={s.nameAction}
                          onPress={() => beginRenewal(record)}
                        >
                          <Icon name="clock" size={16} color={colors.orange} />
                          <Text style={s.nameActionText}>
                            {t('mfwNames.renew')}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          accessibilityRole="button"
                          style={[s.nameAction, s.nameActionDanger]}
                          disabled={preparingNameId === record.id}
                          onPress={() => continueRevocation(record)}
                        >
                          <Icon name="trash" size={16} color={colors.error} />
                          <Text
                            style={[s.nameActionText, s.nameActionTextDanger]}
                          >
                            {t('mfwNames.revoke')}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    ) : canRestart ? (
                      <TouchableOpacity
                        accessibilityRole="button"
                        style={s.nameAction}
                        onPress={() => restartRegistration(record)}
                      >
                        <Icon
                          name="arrow-right"
                          size={16}
                          color={colors.orange}
                        />
                        <Text style={s.nameActionText}>
                          {t('mfwNames.registerAgain')}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        {importingRecovery ? (
          <View style={s.renewalCard}>
            <View style={s.renewalHeader}>
              <View style={s.renewalCopy}>
                <Text style={s.renewalTitle}>
                  {t('mfwNames.restoreRecovery')}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => {
                  setImportingRecovery(false);
                  setRecoveryName('');
                  setMessage(undefined);
                }}
              >
                <Text style={s.cancelRenewal}>
                  {t('mfwNames.cancelRenewal')}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={s.renewalText}>
              {t('mfwNames.restoreRecoveryDescription')}
            </Text>
            <View style={s.nameInputRow}>
              <TextInput
                accessibilityLabel={t('mfwNames.name')}
                style={s.nameInput}
                value={recoveryName}
                onChangeText={value => {
                  setRecoveryName(value.replace(/\.mfw$/i, ''));
                  setMessage(undefined);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={63}
                placeholder={t('mfwNames.namePlaceholder')}
                placeholderTextColor={colors.textMuted}
              />
              <Text style={s.suffix}>.mfw</Text>
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              style={s.secondaryButton}
              disabled={preparingNameId !== undefined}
              onPress={importOwnerRecovery}
            >
              {preparingNameId === 'mfw-recovery-import' ? (
                <ActivityIndicator color={colors.orange} />
              ) : (
                <Icon name="key" size={18} color={colors.orange} />
              )}
              <View style={s.secondaryCopy}>
                <Text style={s.secondaryTitle}>
                  {t('mfwNames.decryptRecovery')}
                </Text>
                <Text style={s.secondaryText}>
                  {t('mfwNames.recoveryNativePrompt')}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        ) : !renewingName && !updatingName && selectedOwnedName ? (
          <TouchableOpacity
            accessibilityRole="button"
            style={s.recoveryButton}
            onPress={() => {
              setImportingRecovery(true);
              setRecoveryName(
                selectedOwnedName.canonicalName.replace(/\.mfw$/i, ''),
              );
              setRenewingNameId(undefined);
              setUpdatingNameId(undefined);
              setMessage(undefined);
            }}
          >
            <Icon name="key" size={17} color={colors.orange} />
            <Text style={s.nameActionText}>
              {t('mfwNames.restoreRecovery')}
            </Text>
          </TouchableOpacity>
        ) : null}

        {renewingName ? (
          <View style={s.renewalCard}>
            <View style={s.renewalHeader}>
              <View style={s.renewalCopy}>
                <Text style={s.renewalTitle}>{t('mfwNames.renewTitle')}</Text>
                <Text style={s.renewalName}>{renewingName.canonicalName}</Text>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => {
                  setRenewingNameId(undefined);
                  setMessage(undefined);
                }}
              >
                <Text style={s.cancelRenewal}>
                  {t('mfwNames.cancelRenewal')}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={s.renewalText}>{t('mfwNames.renewDescription')}</Text>
            <Text style={s.ownedNameAddress}>
              {shortAddress(renewingName.address)}
            </Text>
          </View>
        ) : null}

        {updatingName ? (
          <View style={s.renewalCard}>
            <View style={s.renewalHeader}>
              <View style={s.renewalCopy}>
                <Text style={s.renewalTitle}>{t('mfwNames.updateTitle')}</Text>
                <Text style={s.renewalName}>{updatingName.canonicalName}</Text>
              </View>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => {
                  setUpdatingNameId(undefined);
                  setMessage(undefined);
                }}
              >
                <Text style={s.cancelRenewal}>
                  {t('mfwNames.cancelRenewal')}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={s.renewalText}>{t('mfwNames.updateDescription')}</Text>
            <Text style={s.currentAddressLabel}>
              {t('mfwNames.currentAddress')}
            </Text>
            <Text style={s.ownedNameAddress}>
              {shortAddress(updatingName.address)}
            </Text>
            <Text style={s.sectionLabel}>{t('mfwNames.newAddress')}</Text>
            <View style={s.addressModeRow}>
              <TouchableOpacity
                accessibilityRole="radio"
                accessibilityState={{ selected: addressInputMode === 'wallet' }}
                style={[
                  s.addressModeButton,
                  addressInputMode === 'wallet' && s.addressModeButtonSelected,
                ]}
                onPress={() => {
                  setAddressInputMode('wallet');
                  setMessage(undefined);
                }}
              >
                <Text
                  style={[
                    s.addressModeText,
                    addressInputMode === 'wallet' && s.addressModeTextSelected,
                  ]}
                >
                  {t('mfwNames.chooseWalletAddress')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="radio"
                accessibilityState={{ selected: addressInputMode === 'manual' }}
                style={[
                  s.addressModeButton,
                  addressInputMode === 'manual' && s.addressModeButtonSelected,
                ]}
                onPress={() => {
                  setAddressInputMode('manual');
                  setMessage(undefined);
                }}
              >
                <Text
                  style={[
                    s.addressModeText,
                    addressInputMode === 'manual' && s.addressModeTextSelected,
                  ]}
                >
                  {t('mfwNames.enterAddressManually')}
                </Text>
              </TouchableOpacity>
            </View>
            {addressInputMode === 'manual' ? (
              <TextInput
                accessibilityLabel={t('mfwNames.manualAddress')}
                style={s.manualAddressInput}
                value={manualAddress}
                onChangeText={value => {
                  setManualAddress(value.trim());
                  setMessage(undefined);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t('mfwNames.manualAddressPlaceholder')}
                placeholderTextColor={colors.textMuted}
                spellCheck={false}
              />
            ) : loadingAddresses ? (
              <ActivityIndicator color={colors.orange} style={s.loader} />
            ) : (
              <View style={s.addressList}>
                {addresses
                  .filter(address => address.address !== updatingName.address)
                  .map(address => {
                    const selected = address.id === selectedAddressId;
                    return (
                      <TouchableOpacity
                        key={address.id}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        style={[
                          s.addressCard,
                          selected && s.addressCardSelected,
                        ]}
                        onPress={() => {
                          setSelectedAddressId(address.id);
                          setMessage(undefined);
                        }}
                      >
                        <View style={s.radio}>
                          {selected ? <View style={s.radioDot} /> : null}
                        </View>
                        <View style={s.addressCopy}>
                          <Text style={s.addressLabel}>{address.label}</Text>
                          <Text style={s.addressValue}>
                            {shortAddress(address.address)}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
              </View>
            )}
            {addressInputMode === 'wallet' ? (
              <TouchableOpacity
                accessibilityRole="button"
                style={s.secondaryButton}
                disabled={creatingAddress}
                onPress={createDedicatedAddress}
              >
                {creatingAddress ? (
                  <ActivityIndicator color={colors.orange} />
                ) : (
                  <Icon name="plus" size={18} color={colors.orange} />
                )}
                <View style={s.secondaryCopy}>
                  <Text style={s.secondaryTitle}>
                    {t('mfwNames.createDedicated')}
                  </Text>
                  <Text style={s.secondaryText}>
                    {t('mfwNames.createDedicatedHint')}
                  </Text>
                </View>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {!renewingName &&
        !updatingName &&
        !importingRecovery &&
        !selectedOwnedName ? (
          <>
            {registrationStep === 1 ? (
              <View style={s.hero}>
                <View style={s.heroIcon}>
                  <Icon name="key" size={25} color={colors.orange} />
                </View>
                <View style={s.heroCopy}>
                  <Text style={s.title}>{t('mfwNames.title')}</Text>
                  <Text style={s.subtitle}>{t('mfwNames.subtitle')}</Text>
                </View>
              </View>
            ) : null}

            {registrationStep === 2 ? (
              <>
                <WalletSelector
                  activeWalletId={registeredWallet?.id}
                  snapshots={walletSnapshotMap}
                  titleKey="mfwNames.wallet"
                  wallets={registeredWallets}
                  onSelect={selectWallet}
                />

                <Text style={s.sectionLabel}>{t('mfwNames.address')}</Text>
                <View style={s.addressModeRow}>
                  <TouchableOpacity
                    accessibilityRole="radio"
                    accessibilityState={{
                      selected: addressInputMode === 'wallet',
                    }}
                    style={[
                      s.addressModeButton,
                      addressInputMode === 'wallet' &&
                        s.addressModeButtonSelected,
                    ]}
                    onPress={() => {
                      setAddressInputMode('wallet');
                      setMessage(undefined);
                    }}
                  >
                    <Text
                      style={[
                        s.addressModeText,
                        addressInputMode === 'wallet' &&
                          s.addressModeTextSelected,
                      ]}
                    >
                      {t('mfwNames.chooseWalletAddress')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="radio"
                    accessibilityState={{
                      selected: addressInputMode === 'manual',
                    }}
                    style={[
                      s.addressModeButton,
                      addressInputMode === 'manual' &&
                        s.addressModeButtonSelected,
                    ]}
                    onPress={() => {
                      setAddressInputMode('manual');
                      setMessage(undefined);
                    }}
                  >
                    <Text
                      style={[
                        s.addressModeText,
                        addressInputMode === 'manual' &&
                          s.addressModeTextSelected,
                      ]}
                    >
                      {t('mfwNames.enterAddressManually')}
                    </Text>
                  </TouchableOpacity>
                </View>
                {addressInputMode === 'manual' ? (
                  <TextInput
                    accessibilityLabel={t('mfwNames.manualAddress')}
                    style={s.manualAddressInput}
                    value={manualAddress}
                    onChangeText={value => {
                      setManualAddress(value.trim());
                      setMessage(undefined);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t('mfwNames.manualAddressPlaceholder')}
                    placeholderTextColor={colors.textMuted}
                    spellCheck={false}
                  />
                ) : loadingAddresses ? (
                  <ActivityIndicator color={colors.orange} style={s.loader} />
                ) : addresses.length > 0 ? (
                  <View style={s.addressList}>
                    {addresses.map(address => {
                      const selected = address.id === selectedAddress?.id;
                      return (
                        <TouchableOpacity
                          key={address.id}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          style={[
                            s.addressCard,
                            selected && s.addressCardSelected,
                          ]}
                          onPress={() => {
                            setSelectedAddressId(address.id);
                            setMessage(undefined);
                          }}
                        >
                          <View style={s.radio}>
                            {selected ? <View style={s.radioDot} /> : null}
                          </View>
                          <View style={s.addressCopy}>
                            <Text style={s.addressLabel}>{address.label}</Text>
                            <Text style={s.addressValue}>
                              {shortAddress(address.address)}
                            </Text>
                          </View>
                          {address.addressIndex > 0 ? (
                            <Text style={s.recommended}>
                              {t('mfwNames.dedicated')}
                            </Text>
                          ) : null}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ) : (
                  <Text style={s.empty}>{t('mfwNames.noAddress')}</Text>
                )}

                {addressInputMode === 'wallet' ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    style={s.secondaryButton}
                    disabled={creatingAddress}
                    onPress={createDedicatedAddress}
                  >
                    {creatingAddress ? (
                      <ActivityIndicator color={colors.orange} />
                    ) : (
                      <Icon name="plus" size={18} color={colors.orange} />
                    )}
                    <View style={s.secondaryCopy}>
                      <Text style={s.secondaryTitle}>
                        {t('mfwNames.createDedicated')}
                      </Text>
                      <Text style={s.secondaryText}>
                        {t('mfwNames.createDedicatedHint')}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ) : null}
              </>
            ) : null}

            {registrationStep === 1 ? (
              <>
                <View style={[s.nameInputRow, s.registrationNameInput]}>
                  <TextInput
                    accessibilityLabel={t('mfwNames.name')}
                    style={s.nameInput}
                    value={name}
                    onChangeText={value => {
                      setName(value.replace(/\.mfw$/i, ''));
                      setMessage(undefined);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={63}
                    placeholder={t('mfwNames.namePlaceholder')}
                    placeholderTextColor={colors.textMuted}
                  />
                  <Text style={s.suffix}>.mfw</Text>
                </View>
                {availability.state === 'checking' ? (
                  <View style={s.availabilityRow}>
                    <ActivityIndicator size="small" color={colors.orange} />
                    <Text style={s.availabilityNeutral}>
                      {t('mfwNames.availabilityChecking')}
                    </Text>
                  </View>
                ) : availability.state === 'invalid' ? (
                  <Text style={s.availabilityError}>
                    {t('mfwNames.invalidName')}
                  </Text>
                ) : availability.state === 'unavailable' ? (
                  <Text style={s.availabilityError}>
                    {t('mfwNames.availabilityUnavailable')}
                  </Text>
                ) : availability.state === 'ready' ? (
                  <View style={s.availabilityBlock}>
                    <View style={[s.availabilityRow, s.availabilityBlockRow]}>
                      <Icon
                        name={
                          availability.value.status === 'available'
                            ? 'check'
                            : availability.value.status === 'pending'
                            ? 'clock'
                            : 'lock'
                        }
                        size={16}
                        color={
                          availability.value.status === 'available'
                            ? colors.success
                            : availability.value.status === 'pending'
                            ? colors.warning
                            : colors.error
                        }
                      />
                      <Text
                        style={
                          availability.value.status === 'available'
                            ? s.availabilitySuccess
                            : availability.value.status === 'pending'
                            ? s.availabilityWarning
                            : s.availabilityStatusError
                        }
                      >
                        {availability.value.status === 'available'
                          ? availability.value.previousStatus
                            ? t('mfwNames.availabilityAvailableAgain')
                            : t('mfwNames.availabilityAvailable')
                          : availability.value.status === 'taken'
                          ? t('mfwNames.availabilityTaken')
                          : availability.value.status === 'pending'
                          ? t('mfwNames.availabilityPending')
                          : t('mfwNames.availabilityReserved')}
                      </Text>
                    </View>
                    <View style={s.availabilityDetails}>
                      {availabilityHasExpiry ? (
                        <View style={s.availabilityDetailRow}>
                          <Text style={s.availabilityDetailLabel}>
                            {t('mfwNames.expiresAtBlock')}
                          </Text>
                          <Text style={s.availabilityDetailValue}>
                            {formatHeight(availability.value.expiryHeight!)}
                          </Text>
                        </View>
                      ) : null}
                      {availabilityExpiryTimestampMs !== undefined ? (
                        <View style={s.availabilityDetailRow}>
                          <Text style={s.availabilityDetailLabel}>
                            {availabilityIsExpired
                              ? t('mfwNames.estimatedExpiredAt')
                              : t('mfwNames.estimatedValidUntil')}
                          </Text>
                          <Text style={s.availabilityDetailValue}>
                            {formatDateTime(availabilityExpiryTimestampMs)}
                          </Text>
                        </View>
                      ) : null}
                      <View style={s.availabilityDetailRow}>
                        <Text style={s.availabilityDetailLabel}>
                          {t('mfwNames.checkedChainTip')}
                        </Text>
                        <Text style={s.availabilityDetailValue}>
                          {formatHeight(availability.value.chainTipHeight)}
                        </Text>
                      </View>
                      <View style={s.availabilityDetailRow}>
                        <Text style={s.availabilityDetailLabel}>
                          {t('mfwNames.checkedAt')}
                        </Text>
                        <Text style={s.availabilityDetailValue}>
                          {formatDateTime(availability.checkedAtMs)}
                        </Text>
                      </View>
                      {availabilityHasExpiry ? (
                        <Text style={s.availabilityEstimateHint}>
                          {t('mfwNames.expiryEstimate')}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ) : null}
              </>
            ) : null}

            {registrationStep === 3 ? (
              <View style={s.registrationReview}>
                <View style={s.renewalHeader}>
                  <View style={s.renewalCopy}>
                    <Text style={s.renewalTitle}>
                      {t('mfwNames.reviewTitle')}
                    </Text>
                    <Text style={s.renewalName}>{canonicalMfwName(name)}</Text>
                  </View>
                </View>
                <View style={s.reviewLine}>
                  <Text style={s.currentAddressLabel}>
                    {t('mfwNames.term')}
                  </Text>
                  <Text style={s.reviewValue}>
                    {years}{' '}
                    {years === 1 ? t('mfwNames.year') : t('mfwNames.years')}
                  </Text>
                </View>
                <View style={s.reviewLine}>
                  <Text style={s.currentAddressLabel}>
                    {t('mfwNames.registryPrice')}
                  </Text>
                  <Text style={s.reviewValue}>{feeXmr} XMR</Text>
                </View>
                <Text style={s.currentAddressLabel}>
                  {t('mfwNames.address')}
                </Text>
                <Text style={s.ownedNameAddress}>
                  {shortAddress(enteredAddress)}
                </Text>
              </View>
            ) : null}
          </>
        ) : null}

        {!updatingName &&
        !importingRecovery &&
        (Boolean(renewingName) || registrationStep === 2) ? (
          <>
            <Text style={s.sectionLabel}>{t('mfwNames.term')}</Text>
            <View style={s.termRow}>
              {visibleTerms.map(term => (
                <TouchableOpacity
                  key={term}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: years === term }}
                  style={[s.termButton, years === term && s.termButtonSelected]}
                  onPress={() => {
                    setYearsInput(String(term));
                    setMessage(undefined);
                  }}
                >
                  <Text
                    style={[s.termText, years === term && s.termTextSelected]}
                  >
                    {term}
                  </Text>
                  <Text
                    style={[s.termUnit, years === term && s.termTextSelected]}
                  >
                    {term === 1 ? t('mfwNames.year') : t('mfwNames.years')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.customTermBlock}>
              <Text style={s.customTermLabel}>{t('mfwNames.customTerm')}</Text>
              <View style={s.customTermField}>
                <TextInput
                  accessibilityLabel={t('mfwNames.customTerm')}
                  style={s.customTermInput}
                  value={yearsInput}
                  onChangeText={value => {
                    setYearsInput(value.replace(/[^0-9]/g, ''));
                    setMessage(undefined);
                  }}
                  keyboardType="number-pad"
                  maxLength={4}
                  selectTextOnFocus
                />
                <Text style={s.customTermUnit}>{t('mfwNames.years')}</Text>
              </View>
            </View>
            {!yearsValid ? (
              <Text style={s.availabilityError}>
                {t('mfwNames.termRange', { max: maxYears })}
              </Text>
            ) : null}

            <View style={s.priceCard}>
              <View>
                <Text style={s.priceLabel}>{t('mfwNames.registryPrice')}</Text>
                <Text style={s.priceHint}>
                  {renewingName
                    ? t('mfwNames.renewNetworkFeeExtra')
                    : t('mfwNames.networkFeesExtra')}
                </Text>
              </View>
              <Text style={s.price}>{feeXmr} XMR</Text>
            </View>
          </>
        ) : updatingName ? (
          <View style={s.priceCard}>
            <View>
              <Text style={s.priceLabel}>
                {t('mfwNames.updateNetworkCost')}
              </Text>
              <Text style={s.priceHint}>
                {t('mfwNames.renewNetworkFeeExtra')}
              </Text>
            </View>
          </View>
        ) : null}

        {!importingRecovery &&
        (Boolean(renewingName) ||
          Boolean(updatingName) ||
          registrationStep === 3) ? (
          <View style={s.flowCard}>
            {renewingName ? (
              <>
                <Text style={s.flowTitle}>
                  {t('mfwNames.oneRenewalApproval')}
                </Text>
                <View style={s.flowStep}>
                  <Text style={s.stepNumber}>1</Text>
                  <View style={s.flowCopy}>
                    <Text style={s.flowLabel}>{t('mfwNames.renewTitle')}</Text>
                    <Text style={s.flowText}>
                      {t('mfwNames.renewTransactionText')}
                    </Text>
                  </View>
                </View>
              </>
            ) : updatingName ? (
              <>
                <Text style={s.flowTitle}>
                  {t('mfwNames.oneUpdateApproval')}
                </Text>
                <View style={s.flowStep}>
                  <Text style={s.stepNumber}>1</Text>
                  <View style={s.flowCopy}>
                    <Text style={s.flowLabel}>{t('mfwNames.updateTitle')}</Text>
                    <Text style={s.flowText}>
                      {t('mfwNames.updateTransactionText')}
                    </Text>
                  </View>
                </View>
              </>
            ) : (
              <>
                <Text style={s.flowTitle}>{t('mfwNames.twoApprovals')}</Text>
                <View style={s.flowStep}>
                  <Text style={s.stepNumber}>1</Text>
                  <View style={s.flowCopy}>
                    <Text style={s.flowLabel}>{t('mfwNames.commitTitle')}</Text>
                    <Text style={s.flowText}>{t('mfwNames.commitText')}</Text>
                  </View>
                </View>
                <View style={s.flowLine} />
                <View style={s.flowStep}>
                  <Text style={s.stepNumber}>2</Text>
                  <View style={s.flowCopy}>
                    <Text style={s.flowLabel}>{t('mfwNames.claimTitle')}</Text>
                    <Text style={s.flowText}>{t('mfwNames.claimText')}</Text>
                  </View>
                </View>
              </>
            )}
          </View>
        ) : null}

        {renewingName ||
        updatingName ||
        importingRecovery ||
        registrationStep === 3 ? (
          <View style={s.securityCard}>
            <Icon name="lock" size={18} color={colors.success} />
            <Text style={s.securityText}>{t('mfwNames.ownerKeySecurity')}</Text>
          </View>
        ) : null}

        {!genesis && registrationStep > 1 ? (
          <View style={s.pendingCard}>
            <Icon name="clock" size={18} color={colors.warning} />
            <Text style={s.pendingText}>{t('mfwNames.activationPending')}</Text>
          </View>
        ) : null}
        {message ? <Text style={s.message}>{message}</Text> : null}

        {!importingRecovery &&
        (!selectedOwnedName ||
          Boolean(renewingName) ||
          Boolean(updatingName)) ? (
          <>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={
                renewingName
                  ? t('mfwNames.prepareRenewal')
                  : updatingName
                  ? t('mfwNames.prepareUpdate')
                  : registrationStep === 3
                  ? t('mfwNames.continue')
                  : t('action.continue')
              }
              activeOpacity={0.85}
              disabled={creatingRegistration || preparingNameId !== undefined}
              onPress={
                renewingName
                  ? continueRenewal
                  : updatingName
                  ? continueAddressUpdate
                  : advanceRegistration
              }
            >
              <LinearGradient
                colors={[colors.orange, colors.orangeDark]}
                style={s.primaryButton}
              >
                {creatingRegistration || preparingNameId !== undefined ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <Icon name="arrow-right" size={20} color="#FFF" />
                )}
                <Text style={s.primaryButtonText}>
                  {renewingName
                    ? t('mfwNames.prepareRenewal')
                    : updatingName
                    ? t('mfwNames.prepareUpdate')
                    : registrationStep === 3
                    ? t('mfwNames.continue')
                    : t('action.continue')}
                </Text>
              </LinearGradient>
            </TouchableOpacity>
            {!renewingName && !updatingName && registrationStep > 1 ? (
              <TouchableOpacity
                accessibilityRole="button"
                style={s.registrationBack}
                onPress={() => {
                  setRegistrationStep(current => (current === 3 ? 2 : 1));
                  setMessage(undefined);
                }}
              >
                <Icon
                  name="arrow-left"
                  size={18}
                  color={colors.textSecondary}
                />
                <Text style={s.backText}>{t('action.back')}</Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : null}

        {!loadingOwnedNames &&
        !selectedOwnedName &&
        !renewingName &&
        !updatingName &&
        !importingRecovery &&
        registrationStep === 1 &&
        ownedNames.length > 0 ? (
          <View style={s.recentNames}>
            <View style={s.recentNamesHeader}>
              <View style={s.recentNamesHeadingCopy}>
                <Text style={s.recentNamesTitle}>
                  {t('mfwNames.registeredNames')}
                </Text>
                <Text style={s.recentNamesSubtitle}>
                  {t('mfwNames.registeredNamesSubtitle')}
                </Text>
              </View>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.recentNamesRow}
            >
              {visibleOwnedNames.map(record => {
                const chainTip =
                  walletSnapshotMap[record.walletRegistrationId]
                    ?.daemonHeight ?? record.lastChainTipHeight;
                const stage = effectiveMfwOwnedNameStage({
                  ...record,
                  lastChainTipHeight: chainTip,
                });
                const remainingDays = mfwNameRemainingDays(
                  record.expiryHeight,
                  chainTip,
                );
                return (
                  <TouchableOpacity
                    key={record.id}
                    accessibilityRole="button"
                    activeOpacity={0.76}
                    style={s.recentNameCard}
                    onPress={() => {
                      setSelectedOwnedNameId(record.id);
                      setMessage(undefined);
                    }}
                  >
                    <View style={s.recentNameTop}>
                      <Icon name="key" size={17} color={colors.orange} />
                      <View
                        style={[
                          s.recentNameStatus,
                          stage === 'active' && s.recentNameStatusActive,
                        ]}
                      >
                        <Text
                          style={[
                            s.recentNameStatusText,
                            stage === 'active' && s.recentNameStatusTextActive,
                          ]}
                        >
                          {stageLabel(stage)}
                        </Text>
                      </View>
                    </View>
                    <Text style={s.recentNameLabel} numberOfLines={1}>
                      {record.canonicalName}
                    </Text>
                    <Text style={s.recentNameAddress} numberOfLines={1}>
                      {shortAddress(record.address)}
                    </Text>
                    <Text style={s.recentNameMeta} numberOfLines={1}>
                      {remainingDays === undefined
                        ? record.network
                        : t('mfwNames.daysValue', { count: remainingDays })}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {ownedNames.length > recentOwnedNames.length ? (
              <TouchableOpacity
                accessibilityRole="button"
                style={s.recentNamesMoreRow}
                onPress={() => setShowAllOwnedNames(current => !current)}
              >
                <Text style={s.recentNamesMore}>
                  {showAllOwnedNames
                    ? t('mfwNames.showLess')
                    : t('mfwNames.showMore')}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      <LedgerSigningModal
        progress={ledgerSigningProgress}
        onCancel={() => {
          ledgerSigningCancelledRef.current = true;
          setLedgerSigningProgress(undefined);
        }}
      />
    </View>
  );
}

function parseMfwNameBroadcast(
  value: unknown,
): MfwNameBroadcastResult | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('registrationId' in value) ||
    !('kind' in value) ||
    !('years' in value) ||
    !('txIds' in value)
  ) {
    return undefined;
  }
  const candidate = value as {
    registrationId?: unknown;
    kind?: unknown;
    years?: unknown;
    txIds?: unknown;
  };
  if (
    typeof candidate.registrationId !== 'string' ||
    (candidate.kind !== 'commit' &&
      candidate.kind !== 'claim' &&
      candidate.kind !== 'update' &&
      candidate.kind !== 'renew' &&
      candidate.kind !== 'revoke') ||
    typeof candidate.years !== 'number' ||
    !Number.isSafeInteger(candidate.years) ||
    candidate.years < 1 ||
    candidate.years > MFW_NAME_MAX_TERM_YEARS ||
    !Array.isArray(candidate.txIds) ||
    !candidate.txIds.every(txid => typeof txid === 'string')
  ) {
    return undefined;
  }
  return {
    registrationId: candidate.registrationId,
    kind: candidate.kind,
    years: candidate.years,
    txIds: candidate.txIds,
  };
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 120,
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    marginBottom: 22,
  },
  backText: { color: colors.textSecondary, fontSize: 14 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  heroIcon: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.orangeMuted,
  },
  heroCopy: { flex: 1 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '800' },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  infoCard: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${colors.warning}55`,
    backgroundColor: `${colors.warning}10`,
    padding: 14,
    marginVertical: 22,
  },
  infoText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  namesEmptyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    paddingHorizontal: 14,
  },
  ownedNameList: { gap: 10 },
  recentNames: { marginTop: 34 },
  recentNamesHeader: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  recentNamesHeadingCopy: { flex: 1 },
  recentNamesTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginBottom: 0,
    textTransform: 'uppercase',
  },
  recentNamesSubtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 3,
  },
  recentNamesMore: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
  },
  recentNamesMoreRow: {
    alignItems: 'center',
    paddingTop: 12,
  },
  recentNamesRow: { gap: 10, paddingRight: 20 },
  recentNameCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    minHeight: 122,
    padding: 14,
    width: 158,
  },
  recentNameTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  recentNameStatus: {
    backgroundColor: `${colors.warning}18`,
    borderRadius: radius.full,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  recentNameStatusActive: { backgroundColor: `${colors.success}18` },
  recentNameStatusText: {
    color: colors.warning,
    fontSize: 8,
    fontWeight: '800',
  },
  recentNameStatusTextActive: { color: colors.success },
  recentNameLabel: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
    marginTop: 20,
  },
  recentNameAddress: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: 10,
    marginTop: 5,
  },
  recentNameMeta: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 5,
  },
  ownedNameCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    padding: 15,
  },
  ownedNameHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  ownedNameCopy: { flex: 1 },
  ownedName: { color: colors.textPrimary, fontSize: 18, fontWeight: '800' },
  ownedNameWallet: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 3,
    textTransform: 'capitalize',
  },
  stageBadge: {
    borderRadius: radius.full,
    backgroundColor: `${colors.warning}18`,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  stageBadgeActive: { backgroundColor: `${colors.success}18` },
  stageBadgeProblem: { backgroundColor: `${colors.error}18` },
  stageText: { color: colors.warning, fontSize: 10, fontWeight: '800' },
  stageTextActive: { color: colors.success },
  stageTextProblem: { color: colors.error },
  ownedNameAddress: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: 11,
    marginTop: 10,
  },
  nameMetrics: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  nameMetric: {
    flex: 1,
    borderRadius: radius.sm,
    backgroundColor: colors.bgInput,
    paddingHorizontal: 9,
    paddingVertical: 9,
  },
  nameMetricLabel: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  nameMetricValue: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  expiryHint: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 8,
  },
  nameAction: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    marginTop: 13,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: `${colors.orange}66`,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  nameActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  nameActionDanger: {
    borderColor: `${colors.error}66`,
  },
  nameActionText: { color: colors.orange, fontSize: 12, fontWeight: '800' },
  nameActionTextDanger: { color: colors.error },
  recoveryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    marginTop: 14,
    paddingVertical: 8,
  },
  registrationSteps: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    marginBottom: 6,
    marginTop: 22,
  },
  registrationStep: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  registrationStepActive: {
    backgroundColor: colors.orangeMuted,
    borderColor: colors.orange,
  },
  registrationStepText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
  },
  registrationStepTextActive: { color: colors.orange },
  registrationReview: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: 18,
    padding: 16,
  },
  reviewLine: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  reviewValue: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 12,
  },
  registrationBack: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 7,
    marginTop: 18,
    padding: 8,
  },
  renewalCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.orange,
    backgroundColor: colors.orangeMuted,
    padding: 16,
    marginTop: 22,
  },
  renewalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  renewalCopy: { flex: 1 },
  renewalTitle: { color: colors.textSecondary, fontSize: 12 },
  renewalName: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '800',
    marginTop: 3,
  },
  renewalText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
  },
  currentAddressLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    marginTop: 12,
    textTransform: 'uppercase',
  },
  cancelRenewal: { color: colors.orange, fontSize: 12, fontWeight: '800' },
  sectionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginBottom: 10,
    marginTop: 18,
    textTransform: 'uppercase',
  },
  loader: { marginVertical: 20 },
  addressModeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  addressModeButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  addressModeButtonSelected: {
    backgroundColor: colors.orangeMuted,
    borderColor: colors.orange,
  },
  addressModeText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  addressModeTextSelected: { color: colors.orange },
  manualAddressInput: {
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontFamily: 'monospace',
    fontSize: 12,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  addressList: { gap: 8 },
  addressCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
  },
  addressCardSelected: {
    borderColor: colors.orange,
    backgroundColor: colors.orangeMuted,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.orange,
  },
  addressCopy: { flex: 1, gap: 3 },
  addressLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  addressValue: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: 12,
  },
  recommended: {
    color: colors.success,
    fontSize: 10,
    fontWeight: '700',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 13,
    paddingVertical: 16,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 10,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  secondaryCopy: { flex: 1 },
  secondaryTitle: { color: colors.orange, fontSize: 14, fontWeight: '700' },
  secondaryText: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  nameInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    overflow: 'hidden',
  },
  registrationNameInput: { marginTop: 20 },
  nameInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  suffix: {
    color: colors.orange,
    fontSize: 18,
    fontWeight: '800',
    paddingRight: 16,
  },
  fieldHint: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 7,
  },
  availabilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 9,
  },
  availabilityBlock: { marginTop: 9 },
  availabilityBlockRow: { marginTop: 0 },
  availabilityDetails: {
    gap: 5,
    marginTop: 9,
    padding: 11,
    borderRadius: radius.sm,
    backgroundColor: colors.bgInput,
  },
  availabilityDetailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  availabilityDetailLabel: {
    color: colors.textMuted,
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
  },
  availabilityDetailValue: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
    textAlign: 'right',
  },
  availabilityEstimateHint: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 3,
  },
  availabilityNeutral: { color: colors.textSecondary, fontSize: 12 },
  availabilitySuccess: { color: colors.success, fontSize: 12 },
  availabilityWarning: { color: colors.warning, fontSize: 12 },
  availabilityStatusError: {
    color: colors.error,
    fontSize: 12,
    lineHeight: 17,
  },
  availabilityError: {
    color: colors.error,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 9,
  },
  termRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  customTermBlock: { gap: 7, marginTop: 14 },
  customTermLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  customTermField: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 50,
    overflow: 'hidden',
  },
  customTermInput: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: 18,
    fontWeight: '800',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  customTermUnit: {
    color: colors.textMuted,
    fontSize: 13,
    paddingHorizontal: 16,
  },
  termButton: {
    minWidth: 58,
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  termButtonSelected: {
    borderColor: colors.orange,
    backgroundColor: colors.orangeMuted,
  },
  termText: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  termTextSelected: { color: colors.orange },
  termUnit: { color: colors.textMuted, fontSize: 10, marginTop: 1 },
  priceCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
    padding: 16,
  },
  priceLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  priceHint: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  price: { color: colors.orange, fontSize: 18, fontWeight: '800' },
  flowCard: {
    marginTop: 20,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    padding: 16,
  },
  flowTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 14,
  },
  flowStep: { flexDirection: 'row', gap: 12 },
  stepNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    textAlign: 'center',
    textAlignVertical: 'center',
    lineHeight: 26,
    color: '#FFF',
    backgroundColor: colors.orange,
    fontSize: 13,
    fontWeight: '800',
  },
  flowCopy: { flex: 1 },
  flowLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  flowText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  flowLine: {
    width: 1,
    height: 16,
    backgroundColor: colors.borderLight,
    marginLeft: 13,
    marginVertical: 4,
  },
  securityCard: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: radius.md,
    backgroundColor: `${colors.success}10`,
    padding: 14,
    marginTop: 12,
  },
  securityText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  pendingCard: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: radius.md,
    backgroundColor: `${colors.warning}10`,
    padding: 14,
    marginTop: 12,
  },
  pendingText: {
    flex: 1,
    color: colors.warning,
    fontSize: 12,
    lineHeight: 18,
  },
  message: {
    color: colors.error,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
  },
  primaryButton: {
    minHeight: 56,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 18,
  },
  primaryButtonText: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  walletName: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 12,
  },
});
