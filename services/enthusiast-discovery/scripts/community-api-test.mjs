#!/usr/bin/env node

import {randomUUID} from 'node:crypto';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedBaseUrl = option('--base-url');
const mode = option('--mode') ?? 'local';
if (!requestedBaseUrl) {
  throw new Error('Usage: community-api-test.mjs --base-url <URL> [--mode local|live]');
}
if (mode === 'live' && process.env.TESTBENCH_ALLOW_COMMUNITY_LIVE !== '1') {
  throw new Error('Live Community tests require TESTBENCH_ALLOW_COMMUNITY_LIVE=1.');
}

const baseUrl = requestedBaseUrl.replace(/\/+$/, '');
const runId = option('--run-id') ?? randomUUID().replaceAll('-', '').slice(0, 10);
const marker = `TB-${runId}`;
const accounts = [];
const passed = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function pass(name) {
  passed.push(name);
  console.log(`ok - ${name}`);
}

async function request(name, {method = 'GET', path, token, body, expected}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let value = undefined;
    if (raw) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    const expectedStatuses = Array.isArray(expected) ? expected : [expected];
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`${name}: expected HTTP ${expectedStatuses.join(' or ')}, received ${response.status}`);
    }
    return value;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${name}: request timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function createAccount(label) {
  const response = await request(`create ${label}`, {
    method: 'POST',
    path: '/v1/identities',
    body: {display_name: `${marker} ${label}`},
    expected: 201,
  });
  assert(typeof response?.identity_id === 'string', `create ${label}: missing identity id`);
  assert(typeof response?.access_token === 'string', `create ${label}: missing access token`);
  const account = {id: response.identity_id, token: response.access_token, deleted: false};
  accounts.push(account);
  return account;
}

async function deleteAccount(account) {
  if (account.deleted) {
    return;
  }
  await request('delete test identity', {
    method: 'DELETE',
    path: '/v1/profile',
    token: account.token,
    expected: [204, 401],
  });
  account.deleted = true;
}

async function cleanup() {
  const failures = [];
  for (const account of [...accounts].reverse()) {
    try {
      await deleteAccount(account);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length) {
    throw new Error(`test identity cleanup failed: ${failures.join('; ')}`);
  }
}

async function run() {
  let primaryError;
  try {
    const info = await request('service information', {path: '/', expected: 200});
    assert(info?.service === 'Monero enthusiast discovery', 'service information: unexpected service');
    pass('service information endpoint');

    const health = await request('health check', {path: '/healthz', expected: 200});
    assert(health?.ok === true, 'health check: expected ok=true');
    pass('health endpoint');

    await request('reject invalid anonymous identity', {
      method: 'POST',
      path: '/v1/identities',
      body: {display_name: 'x'},
      expected: 400,
    });
    await request('reject unauthenticated profile access', {
      path: '/v1/profile',
      expected: 401,
    });
    await request('reject invalid bearer token', {
      path: '/v1/profile',
      token: 'invalid-community-token',
      expected: 401,
    });
    pass('anonymous identity and bearer-token boundaries');

    const alice = await createAccount('Alice');
    const bob = await createAccount('Bob');
    pass('anonymous identities created');

    await request('reject visible profile without approximate area', {
      method: 'PUT',
      path: '/v1/profile',
      token: alice.token,
      body: {
        display_name: `${marker} Alice`,
        bio: '',
        area_id: null,
        visible: true,
        radius_km: 10,
      },
      expected: 400,
    });
    await request('reject exact coordinates', {
      method: 'PUT',
      path: '/v1/profile',
      token: alice.token,
      body: {
        display_name: `${marker} Alice`,
        bio: '',
        area_id: 'zzzzz',
        visible: true,
        radius_km: 10,
        latitude: 47.0707,
        longitude: 15.4395,
      },
      expected: 422,
    });
    pass('location-privacy input validation');

    for (const [label, account] of [['Alice', alice], ['Bob', bob]]) {
      await request(`publish ${label} approximate area`, {
        method: 'PUT',
        path: '/v1/profile',
        token: account.token,
        body: {
          display_name: `${marker} ${label}`,
          bio: 'Automated Community acceptance test',
          area_id: 'zzzzz',
          visible: true,
          radius_km: 10,
        },
        expected: 200,
      });
    }
    const profile = await request('read public profile', {
      path: '/v1/profile',
      token: alice.token,
      expected: 200,
    });
    for (const privateField of ['area_id', 'latitude', 'longitude', 'access_token', 'token_hash']) {
      assert(!(privateField in profile), `public profile leaked ${privateField}`);
    }
    await request('refresh approximate presence', {
      method: 'POST',
      path: '/v1/presence',
      token: alice.token,
      expected: 200,
    });
    pass('approximate presence and non-leaking profile response');

    const nearby = await request('find nearby profile', {
      path: '/v1/nearby?radius_km=10',
      token: alice.token,
      expected: 200,
    });
    const nearbyBob = Array.isArray(nearby) ? nearby.find((entry) => entry.identity_id === bob.id) : undefined;
    assert(nearbyBob?.relationship === 'none', 'nearby profile should start without a relationship');
    assert(!('area_id' in nearbyBob), 'nearby response leaked area_id');
    pass('nearby discovery uses only approximate distance');

    await request('reject chat before mutual approval', {
      method: 'POST',
      path: `/v1/conversations/${bob.id}/messages`,
      token: alice.token,
      body: {body: 'Too early'},
      expected: 400,
    });
    await request('request contact', {
      method: 'POST',
      path: `/v1/contacts/${bob.id}`,
      token: alice.token,
      expected: 204,
    });
    const aliceContacts = await request('list outgoing contact', {
      path: '/v1/contacts',
      token: alice.token,
      expected: 200,
    });
    const bobContacts = await request('list incoming contact', {
      path: '/v1/contacts',
      token: bob.token,
      expected: 200,
    });
    assert(aliceContacts.find((entry) => entry.identity_id === bob.id)?.status === 'outgoing', 'contact request was not outgoing');
    assert(bobContacts.find((entry) => entry.identity_id === alice.id)?.status === 'incoming', 'contact request was not incoming');
    await request('accept contact', {
      method: 'POST',
      path: `/v1/contacts/${alice.id}/accept`,
      token: bob.token,
      expected: 204,
    });
    const acceptedContacts = await request('list accepted contact', {
      path: '/v1/contacts',
      token: alice.token,
      expected: 200,
    });
    assert(acceptedContacts.find((entry) => entry.identity_id === bob.id)?.status === 'connected', 'contact was not connected');
    pass('mutual contact approval');

    await request('reject empty message', {
      method: 'POST',
      path: `/v1/conversations/${bob.id}/messages`,
      token: alice.token,
      body: {body: ''},
      expected: 400,
    });
    const sent = await request('send approved message', {
      method: 'POST',
      path: `/v1/conversations/${bob.id}/messages`,
      token: alice.token,
      body: {body: `Automated message ${marker}`},
      expected: 201,
    });
    assert(typeof sent?.sent_at_ms === 'number', 'sent message did not include timestamp');
    const messages = await request('list approved messages', {
      path: `/v1/conversations/${alice.id}/messages`,
      token: bob.token,
      expected: 200,
    });
    assert(messages.some((entry) => entry.id === sent.id && entry.body === sent.body), 'approved message was not visible to peer');
    const newerMessages = await request('filter messages after timestamp', {
      path: `/v1/conversations/${alice.id}/messages?after_ms=${sent.sent_at_ms}`,
      token: bob.token,
      expected: 200,
    });
    assert(!newerMessages.some((entry) => entry.id === sent.id), 'message after_ms filter included old message');
    pass('approved chat and message cursor');

    await request('report test profile', {
      method: 'POST',
      path: `/v1/reports/${bob.id}`,
      token: alice.token,
      body: {reason: `Automated test report ${marker}`},
      expected: 204,
    });
    await request('block test profile', {
      method: 'POST',
      path: `/v1/blocks/${bob.id}`,
      token: alice.token,
      expected: 204,
    });
    const contactsAfterBlock = await request('list contacts after block', {
      path: '/v1/contacts',
      token: alice.token,
      expected: 200,
    });
    assert(contactsAfterBlock.length === 0, 'block did not remove the contact');
    const nearbyAfterBlock = await request('find nearby after block', {
      path: '/v1/nearby?radius_km=10',
      token: alice.token,
      expected: 200,
    });
    assert(!nearbyAfterBlock.some((entry) => entry.identity_id === bob.id), 'block did not hide nearby profile');
    await request('reject chat after block', {
      path: `/v1/conversations/${bob.id}/messages`,
      token: alice.token,
      expected: 400,
    });
    pass('report, block, contact removal, and chat revocation');

    await deleteAccount(alice);
    await deleteAccount(bob);
    await request('reject deleted identity token', {
      path: '/v1/profile',
      token: alice.token,
      expected: 401,
    });
    pass('identity deletion and test-data cleanup');
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  console.log(`summary: pass=${passed.length} mode=${mode}`);
}

run().catch((error) => {
  console.error(`not ok - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
