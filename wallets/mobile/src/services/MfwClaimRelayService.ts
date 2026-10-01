import {
  FIXED_MAINNET_NODES,
  PRIMARY_PRIVATE_SERVICE_ORIGIN,
} from '../../../../packages/wallet-shared/src/nodePresets';
import { requireNativeMoneroWallet } from './NativeMoneroWallet';
import { loadActiveNodeConnectionSettings } from './NodeConnectionSettings';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import { torFetch } from './TorHttp';
import {
  loadMfwOwnedNames,
  upsertMfwOwnedName,
  type MfwOwnedNameRecord,
} from './MfwNameRegistrationRegistry';

const STORAGE = 'monero-fast-wallet.mfw-claim-relay.v1';
const ORIGIN = PRIMARY_PRIVATE_SERVICE_ORIGIN;
const PATH = '/v1/mfw/claim-relay';
const ID = /^[0-9a-f]{48}$/;
const HASH = /^[0-9a-f]{64}$/;
type RemoteState =
  | 'waiting'
  | 'relaying'
  | 'broadcast'
  | 'confirmed'
  | 'expired'
  | 'rejected'
  | 'cancelled';
type DeliveryState = 'uploading' | RemoteState;
type Submission = {
  commitTxid: string;
  claimTxid: string;
  rawTxHex: string;
  installationId: string | null;
};
type Job = {
  jobId: string;
  token: string;
  registrationId: string;
  walletRegistrationId: string;
  state: DeliveryState;
  createdAt: string;
  submission: Submission;
};
const terminal = (state: DeliveryState) =>
  ['confirmed', 'expired', 'rejected', 'cancelled'].includes(state);
let mutation: Promise<unknown> = Promise.resolve();
let networkMutation: Promise<unknown> = Promise.resolve();
let refresh: Promise<void> | undefined;

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = mutation.then(work, work);
  mutation = next.catch(() => undefined);
  return next;
}

function serializeNetwork<T>(work: () => Promise<T>): Promise<T> {
  const next = networkMutation.then(work, work);
  networkMutation = next.catch(() => undefined);
  return next;
}

async function loadJobs(): Promise<Job[]> {
  const encoded = await loadProtectedMetadata(STORAGE);
  if (!encoded) return [];
  const value: unknown = JSON.parse(encoded);
  // Corrupted custody metadata must never silently unlock pending inputs.
  if (
    !Array.isArray(value) ||
    value.some(
      job =>
        !job ||
        !ID.test(job.jobId) ||
        !ID.test(job.token) ||
        typeof job.registrationId !== 'string' ||
        !job.registrationId ||
        typeof job.walletRegistrationId !== 'string' ||
        !job.walletRegistrationId ||
        !Number.isFinite(Date.parse(job.createdAt)) ||
        ![
          'uploading',
          'waiting',
          'relaying',
          'broadcast',
          'confirmed',
          'expired',
          'rejected',
          'cancelled',
        ].includes(job.state) ||
        !HASH.test(job.submission?.commitTxid) ||
        !HASH.test(job.submission?.claimTxid) ||
        typeof job.submission?.rawTxHex !== 'string' ||
        (!terminal(job.state) && !/^[0-9a-f]+$/.test(job.submission.rawTxHex)),
    )
  ) {
    throw new Error('The saved claim delivery state could not be read safely.');
  }
  return value as Job[];
}

async function saveJob(job: Job): Promise<void> {
  // Retain routing tombstones, not spent/expired signed transaction blobs.
  const stored = terminal(job.state)
    ? { ...job, submission: { ...job.submission, rawTxHex: '' } }
    : job;
  await serialized(async () => {
    const jobs = await loadJobs();
    await storeProtectedMetadata(
      STORAGE,
      JSON.stringify([
        ...jobs.filter(item => item.jobId !== job.jobId),
        stored,
      ]),
    );
  });
}

/** No silent contact with our relay when the user selected a different node. */
export async function canUseMfwClaimRelay(network: string): Promise<boolean> {
  if (network !== 'mainnet') return false;
  const settings = await loadActiveNodeConnectionSettings('mainnet');
  const authority = settings.daemon.address
    .replace(/^https?:\/\//, '')
    .split('/')[0];
  const host = authority.split(':')[0];
  if (
    host !== FIXED_MAINNET_NODES.tex8.clearnetHost &&
    host !== FIXED_MAINNET_NODES.tex8.onionHost
  )
    return false;
  try {
    const response = await torFetch(`${ORIGIN}${PATH}/capabilities`, {
      timeoutMs: 8_000,
      maximumResponseBytes: 4096,
    });
    const value = await response.json();
    return (
      response.ok &&
      value.version === 1 &&
      value.network === 'mainnet' &&
      value.durable === true &&
      value.commitMaturityBlocks === 15 &&
      value.commitRevealWindowBlocks === 720
    );
  } catch {
    return false;
  }
}

async function identifier(): Promise<string> {
  const value = await requireNativeMoneroWallet().createSecureRandomIdentifier(
    'claim',
  );
  const id = value.replace(/^claim_/, '');
  if (!ID.test(id))
    throw new Error('Secure claim identifier generation failed.');
  return id;
}

/** Store BEFORE upload; retry exactly the same job/token/bytes after timeout. */
export async function scheduleServerMfwClaim(input: {
  registrationId: string;
  walletRegistrationId: string;
  commitTxid: string;
  claimTxid: string;
  rawTxHex: string;
  installationId?: string;
}): Promise<void> {
  const job: Job = {
    jobId: await identifier(),
    token: await identifier(),
    registrationId: input.registrationId,
    walletRegistrationId: input.walletRegistrationId,
    createdAt: new Date().toISOString(),
    state: 'uploading',
    submission: {
      commitTxid: input.commitTxid,
      claimTxid: input.claimTxid,
      rawTxHex: input.rawTxHex,
      installationId: input.installationId ?? null,
    },
  };
  if (
    !HASH.test(input.claimTxid) ||
    !HASH.test(input.commitTxid) ||
    !/^[0-9a-f]+$/.test(input.rawTxHex) ||
    // Native Tor requests are bounded to 64 KiB. Leave room for JSON;
    // larger claims use the existing manual flow rather than a stuck upload.
    input.rawTxHex.length > 60_000 ||
    input.rawTxHex.length % 2 !== 0
  ) {
    throw new Error('Invalid signed claim.');
  }
  await serialized(async () => {
    const jobs = await loadJobs();
    if (
      jobs.some(
        item =>
          !terminal(item.state) &&
          item.walletRegistrationId === input.walletRegistrationId,
      )
    ) {
      throw new Error(
        'A signed claim is already awaiting delivery for this wallet.',
      );
    }
    await storeProtectedMetadata(STORAGE, JSON.stringify([...jobs, job]));
  });
  await reconcileRecord(job);
  // Failure here is an uncertain upload, NOT a failed signature. The durable
  // local row blocks a second preparation and retries after the next unlock.
  await serializeNetwork(() => syncJob(job)).catch(() => undefined);
}

async function syncJob(job: Job): Promise<void> {
  const response = await torFetch(`${ORIGIN}${PATH}/jobs/${job.jobId}`, {
    method: job.state === 'uploading' ? 'PUT' : 'GET',
    headers: {
      Authorization: `Bearer ${job.token}`,
      'Content-Type': 'application/json',
    },
    ...(job.state === 'uploading'
      ? { body: JSON.stringify(job.submission) }
      : {}),
    timeoutMs: 20_000,
    maximumResponseBytes: 8192,
  });
  if (!response.ok)
    throw new Error('Claim delivery status is not available yet.');
  const status = await response.json();
  if (
    status.jobId !== job.jobId ||
    status.claimTxid !== job.submission.claimTxid ||
    ![
      'waiting',
      'relaying',
      'broadcast',
      'confirmed',
      'expired',
      'rejected',
      'cancelled',
    ].includes(status.state)
  ) {
    throw new Error('Invalid claim delivery receipt.');
  }
  const next: Job = { ...job, state: status.state };
  await saveJob(next);
  await reconcileRecord(next);
}

async function reconcileRecord(job: Job): Promise<void> {
  const records = await loadMfwOwnedNames();
  const record = records.find(item => item.id === job.registrationId);
  if (
    !record ||
    record.stage === 'active' ||
    record.commitTxidHex !== job.submission.commitTxid
  )
    return;
  if (job.state === 'cancelled') {
    if (record.claimRelayJobId === job.jobId) {
      await upsertMfwOwnedName({
        ...record,
        stage: 'commit-pending',
        sourceTxidHex: undefined,
        claimScheduledAt: undefined,
        claimRelayJobId: undefined,
        claimRelayState: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    return;
  }
  const stage: MfwOwnedNameRecord['stage'] =
    job.state === 'expired'
      ? 'claim-expired'
      : job.state === 'rejected'
      ? 'failed'
      : 'claim-pending';
  const next = {
    ...record,
    stage,
    sourceTxidHex: job.submission.claimTxid,
    commitTxidHex: job.submission.commitTxid,
    claimScheduledAt: job.createdAt,
    claimRelayState: job.state,
    claimRelayJobId: job.jobId,
  };
  if (
    record.stage !== stage ||
    record.sourceTxidHex !== next.sourceTxidHex ||
    record.claimScheduledAt !== next.claimScheduledAt ||
    record.claimRelayState !== job.state ||
    record.claimRelayJobId !== job.jobId
  ) {
    await upsertMfwOwnedName({ ...next, updatedAt: new Date().toISOString() });
  }
}

export async function refreshMfwClaimRelayJobs(): Promise<void> {
  if (refresh) return refresh;
  refresh = serializeNetwork(async () => {
    for (const job of await loadJobs()) {
      if (terminal(job.state)) {
        await reconcileRecord(job);
        continue;
      }
      await syncJob(job).catch(() => undefined);
    }
  }).finally(() => {
    refresh = undefined;
  });
  return refresh;
}

/** The server acknowledgement is required before allowing a manual re-sign. */
export async function cancelServerMfwClaim(
  registrationId: string,
): Promise<void> {
  return serializeNetwork(async () => {
    const job = (await loadJobs()).find(
      item => item.registrationId === registrationId && !terminal(item.state),
    );
    if (!job) return;
    // Establish the idempotent job if an earlier PUT acknowledgement was lost.
    // A local 404 alone cannot prove an in-flight PUT will never arrive.
    if (job.state === 'uploading') await syncJob(job);
    const response = await torFetch(`${ORIGIN}${PATH}/jobs/${job.jobId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${job.token}` },
      timeoutMs: 20_000,
      maximumResponseBytes: 8192,
    });
    const status = await response.json();
    if (
      !response.ok ||
      status.jobId !== job.jobId ||
      status.claimTxid !== job.submission.claimTxid ||
      status.state !== 'cancelled'
    ) {
      throw new Error(
        'Automatic delivery could not be cancelled safely. Check its status before trying again.',
      );
    }
    const next: Job = { ...job, state: 'cancelled' };
    await saveJob(next);
    await reconcileRecord(next);
  });
}

export async function assertNoHeldMfwClaim(
  walletRegistrationId: string | undefined,
): Promise<void> {
  const jobs = await loadJobs();
  if (
    jobs.some(
      job =>
        job.walletRegistrationId === walletRegistrationId &&
        !terminal(job.state),
    )
  ) {
    throw new Error(
      'A signed name claim is awaiting delivery or confirmation. Its funds are reserved; check the name registration status before sending again.',
    );
  }
}
