export type FixedNodeId = 'tex8' | 'community';
export type FixedNodeTransport = 'clearnet' | 'onion';

export interface FixedNodeConnection {
  node: FixedNodeId;
  transport: FixedNodeTransport;
  mode: 'optimized-grpc' | 'original-rpc';
  daemonAddress: string;
  grpcEndpoint: string;
  proxyAddress: string;
}

export interface FixedMainnetNode {
  id: FixedNodeId;
  role: 'official' | 'community';
  label: string;
  clearnetHost: string;
  onionHost: string;
}

/**
 * Release-pinned mainnet endpoints shared by the wallet clients. Keeping the
 * four visible addresses in one source prevents the settings UI and the
 * connection preset from drifting apart.
 */
export const FIXED_MAINNET_NODES: Record<FixedNodeId, FixedMainnetNode> = {
  tex8: {
    id: 'tex8',
    role: 'official',
    label: 'TEX8 Node',
    clearnetHost: 'xmr.tex8.com',
    onionHost:
      'fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion',
  },
  community: {
    id: 'community',
    role: 'community',
    label: 'Community Node',
    clearnetHost: '199.30.65.42',
    onionHost:
      'quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion',
  },
};

export const FIXED_MAINNET_NODE_IDS: readonly FixedNodeId[] = [
  'tex8',
  'community',
];

export function fixedNodeRpcAuthority(node: FixedNodeId): string {
  return `${FIXED_MAINNET_NODES[node].clearnetHost}:18089`;
}

export function fixedNodeGrpcAuthority(node: FixedNodeId): string {
  return `${FIXED_MAINNET_NODES[node].clearnetHost}:18091`;
}

export function fixedNodeOnionAuthority(node: FixedNodeId): string {
  return `${FIXED_MAINNET_NODES[node].onionHost}:18089`;
}

/**
 * Hidden-service origin for bounded app traffic. Block payloads deliberately
 * keep using the separate Clearnet gRPC authority above.
 */
export function fixedNodeOnionOrigin(node: FixedNodeId): string {
  return `http://${FIXED_MAINNET_NODES[node].onionHost}`;
}

export const PRIMARY_PRIVATE_SERVICE_ORIGIN = fixedNodeOnionOrigin('tex8');
export const SECONDARY_PRIVATE_SERVICE_ORIGIN =
  fixedNodeOnionOrigin('community');

/**
 * One product-level preset used by both wallet frontends. Onion endpoints use
 * the original daemon RPC through the user's local Tor SOCKS5 proxy; clearnet
 * endpoints use the MFN gRPC acceleration path.
 */
export function fixedMainnetNodeConnection(
  node: FixedNodeId,
  transport: FixedNodeTransport,
): FixedNodeConnection {
  if (transport === 'onion') {
    return {
      node,
      transport,
      mode: 'original-rpc',
      daemonAddress: fixedNodeOnionAuthority(node),
      grpcEndpoint: '',
      proxyAddress: '127.0.0.1:9050',
    };
  }

  return {
    node,
    transport,
    mode: 'optimized-grpc',
    daemonAddress: fixedNodeRpcAuthority(node),
    grpcEndpoint: fixedNodeGrpcAuthority(node),
    proxyAddress: '',
  };
}
