import {FIXED_MAINNET_NODES} from './nodePresets';

export type ProjectPageTransport = 'clearnet' | 'onion';
export type ProjectPageAddressId =
  | 'tex8-clearnet'
  | 'community-clearnet'
  | 'tex8-onion'
  | 'community-onion';
export type ProjectServiceId =
  | 'wallet'
  | 'node'
  | 'relay'
  | 'worker'
  | 'registry'
  | 'all';

export type ProjectPageAddress = {
  id: ProjectPageAddressId;
  label: string;
  transport: ProjectPageTransport;
  address: string;
  url: string;
};

export type ProjectServiceLink = {
  id: ProjectServiceId;
  url: string;
};

export const PROJECT_PAGE_CLEARNET_ORIGIN = 'https://xmr.tex8.com';
export const PROJECT_SOURCE_URL =
  'https://github.com/tex8com/monero-fast-wallet';

/**
 * The public project-page addresses shown by the landing page and both wallet
 * clients. Node connection ports remain in nodePresets.ts; these are browser
 * entry points for people who want to inspect the project and its services.
 */
export const PROJECT_PAGE_ADDRESSES: ReadonlyArray<ProjectPageAddress> = [
  {
    id: 'tex8-clearnet',
    label: 'TEX8',
    transport: 'clearnet',
    address: 'xmr.tex8.com',
    url: `${PROJECT_PAGE_CLEARNET_ORIGIN}/`,
  },
  {
    id: 'community-clearnet',
    label: 'Community',
    transport: 'clearnet',
    address: 'mfw-resolver2.tex8.com',
    url: 'https://mfw-resolver2.tex8.com/',
  },
  {
    id: 'tex8-onion',
    label: 'TEX8 Onion',
    transport: 'onion',
    address: FIXED_MAINNET_NODES.tex8.onionHost,
    url: `http://${FIXED_MAINNET_NODES.tex8.onionHost}/`,
  },
  {
    id: 'community-onion',
    label: 'Community Onion',
    transport: 'onion',
    address: FIXED_MAINNET_NODES.community.onionHost,
    url: `http://${FIXED_MAINNET_NODES.community.onionHost}/`,
  },
];

export const PROJECT_SERVICE_LINKS: ReadonlyArray<ProjectServiceLink> = [
  {id: 'wallet', url: `${PROJECT_PAGE_CLEARNET_ORIGIN}/#wallet`},
  {id: 'node', url: `${PROJECT_PAGE_CLEARNET_ORIGIN}/#mfn`},
  {id: 'relay', url: `${PROJECT_PAGE_CLEARNET_ORIGIN}/#relay`},
  {id: 'worker', url: `${PROJECT_PAGE_CLEARNET_ORIGIN}/#worker`},
  {id: 'registry', url: `${PROJECT_PAGE_CLEARNET_ORIGIN}/#registry`},
  {id: 'all', url: `${PROJECT_PAGE_CLEARNET_ORIGIN}/#services`},
];
