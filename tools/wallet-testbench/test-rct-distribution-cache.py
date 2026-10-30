#!/usr/bin/env python3
"""Hermetic tests of the authenticated public RCT cache; no sockets or wallets."""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
lock = (root / 'third_party/monero-patches/upstream.lock').read_text()
expected = re.search(r'^patched_tree=([0-9a-f]{40})$', lock, re.M).group(1)
source = args.source or Path('/Volumes/4TB/CACHE/monero-fast-wallet-build') / ('monero-common-core-' + expected)
assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD^{tree}'], text=True).strip() == expected
subprocess.run(['git', '-C', str(source), 'diff', '--quiet', 'HEAD', '--', 'src/wallet', 'contrib/epee/include/net/http_client.h', 'contrib/epee/include/net/net_ssl.h'], check=True)
series = [line for line in (root / 'third_party/monero-patches/series').read_text().splitlines() if line and not line.startswith('#')]
assert series[97] == '0098-wallet-cache-zero-fork-heights.patch'
assert series[98] == '0099-wallet-cache-public-rct-distributions.patch'
assert [int(line[:4]) for line in series] == list(range(1, len(series) + 1))
wallet = (source / 'src/wallet/wallet2.cpp').read_text()
adapter = (source / 'src/wallet/rct_distribution_rpc.cpp').read_text()
http = (source / 'contrib/epee/include/net/http_client.h').read_text()
assert 'request.cumulative = from != 0' in adapter
assert 'request.to_height = to' in adapter
assert 'profile_id(config, true)' in adapter and 'profile_id(config, false)' in adapter
assert 'auto factory = [config]' in adapter and '[this]' not in adapter
assert 'O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW' in adapter
assert '::fstat(fd, &info)' in adapter and 'tools::replace_file' in adapter and '::fsync(fd)' in adapter
assert 'cache->requires_payment()' in wallet
receive = http[http.index('inline bool handle_reciev('):]
assert receive.index('on_response_chunk(std::string())') < receive.index('m_net_client.recv(')
assert receive.index('on_response_chunk(recv_buffer)') < receive.index('handle_header(recv_buffer')
assert 'client_.aborted()' in adapter


def extract(text, signature):
    start = text.index(signature)
    brace = text.index('{', start)
    depth = 1
    cursor = brace + 1
    while depth:
        depth += (text[cursor] == '{') - (text[cursor] == '}')
        cursor += 1
    return text[start:cursor]


identity = extract(adapter, 'std::string profile_id(')
field = extract(adapter, 'void identity_field(')
bounded = extract(adapter, 'class bounded_client') + ';'
extra = r'''
#include "rct_distribution_cache.h"
#include <cassert>
#include <cctype>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <sstream>
namespace epee { namespace net_utils {
namespace http { struct http_response_info {}; struct url_content { std::string host,schema; unsigned port=0; }; }
bool parse_url(const std::string& value,http::url_content& url) {
 auto delimiter=value.find("://");
 auto authority=delimiter==std::string::npos?value:value.substr(delimiter+3);
 url.schema=delimiter==std::string::npos?"":value.substr(0,delimiter);
 auto colon=authority.rfind(':'); url.host=colon==std::string::npos?authority:authority.substr(0,colon);
 url.port=colon==std::string::npos?0:unsigned(std::stoul(authority.substr(colon+1))); return true;
}
} }
namespace net { namespace http {
class client { public:
 virtual ~client()=default;
 virtual bool handle_target_data(std::string& piece) { piece.clear(); return true; }
 virtual bool on_header(const epee::net_utils::http::http_response_info&) { return true; }
 virtual bool on_response_chunk(const std::string&) { return true; }
};
} }
namespace tools { namespace rct_cache {
void memwipe(void* data,size_t size) { std::memset(data,0,size); }
std::string digest(const std::string& value) {
 std::ostringstream out;
 for(uint64_t lane=0;lane<4;++lane) {
  uint64_t hash=1469598103934665603ULL+lane;
  for(unsigned char c:value) {hash^=c;hash*=1099511628211ULL;}
  out<<std::hex<<std::setw(16)<<std::setfill('0')<<hash;
 }
 return out.str();
}
struct credentials {std::string username,password;};
struct ssl_config {
 int support=0,verification=0;std::string ca_path;
 struct {std::string certificate_path,private_key_path;} auth;
 std::vector<std::vector<uint8_t>> fingerprints;
 const std::vector<std::vector<uint8_t>>& cache_fingerprints() const {return fingerprints;}
};
struct profile {uint8_t network=0;std::string address,proxy,genesis;std::shared_ptr<credentials> login;ssl_config ssl;};
IDENTITY_FIELD
PROFILE_ID
BOUNDED_CLIENT
} }
int main() {
 using namespace tools::rct_cache;
 profile base; base.address="http://EXAMPLE.onion:18089";base.proxy="127.0.0.1:19050";base.genesis=std::string(64,'a');
 base.login=std::make_shared<credentials>();base.login->username="operator";base.login->password="test-auth-one";
 auto disk=profile_id(base,false),transport=profile_id(base,true);
 auto changed=base;changed.address="http://example.onion:18089";assert(profile_id(changed,false)==disk);
 changed=base;changed.proxy="127.0.0.1:31337";assert(profile_id(changed,true)!=transport && profile_id(changed,false)==disk);
 changed=base;changed.login=std::make_shared<credentials>(*base.login);changed.login->password="test-auth-two";
 assert(profile_id(changed,true)!=transport && profile_id(changed,false)==disk);
 changed.login->username="other-operator";assert(profile_id(changed,false)!=disk);
 changed=base;changed.network=1;assert(profile_id(changed,false)!=disk);
 changed=base;changed.ssl.support=1;assert(profile_id(changed,false)!=disk);
 changed=base;changed.ssl.verification=1;assert(profile_id(changed,false)!=disk);
 changed=base;changed.ssl.fingerprints={{1,2,3}};assert(profile_id(changed,false)!=disk);
 changed=base;changed.ssl.ca_path="different-ca";assert(profile_id(changed,false)!=disk);
 changed=base;changed.address="http://other.onion:18089";assert(profile_id(changed,false)!=disk);
 std::cout<<"PASS actual profile identity: exact active proxy/auth, stable disk across proxy-port/password changes, network/daemon/TLS/user partitions\n";
 {
  auto token=std::make_shared<cancellation>(std::chrono::seconds(1));bounded_client client(token);client.begin(1024*1024);
  assert(client.on_response_chunk("HTTP/1.1 200 OK\r\nX: partial\r"));token->stopped=true;
  assert(!client.on_response_chunk("") && client.aborted());
 }
 {
  auto token=std::make_shared<cancellation>(std::chrono::milliseconds(10));bounded_client client(token);client.begin(1024*1024);
  assert(client.on_response_chunk("HTTP/1.1 200 OK\r\n\r\n"));std::this_thread::sleep_for(std::chrono::milliseconds(20));
  assert(!client.on_response_chunk("trickled chunk head") && client.aborted());
 }
 {
  auto token=std::make_shared<cancellation>(std::chrono::seconds(1));bounded_client client(token);client.begin(1024*1024);
  assert(!client.on_response_chunk(std::string(65536,'H')) && client.aborted());
 }
 {
  auto token=std::make_shared<cancellation>(std::chrono::seconds(1));bounded_client client(token);client.begin(4);
  assert(client.on_response_chunk("HTTP/1.1 200 OK\r\n\r\n"));std::string body="12345";
  assert(!client.handle_target_data(body) && client.aborted());
 }
 std::cout<<"PASS actual receive callbacks: cancel, absolute deadline, partial-header bound and body cap without raw payload publication\n";
}
'''
extra = extra.replace('IDENTITY_FIELD', field).replace('PROFILE_ID', identity).replace('BOUNDED_CLIENT', bounded)
with tempfile.TemporaryDirectory(prefix='mfw-rct-cache-tests-') as temporary:
    directory = Path(temporary)
    includes = ['-I' + str(source / 'src/wallet')]
    for name, code in [('cache', (root / 'tools/wallet-testbench/rct-distribution-cache-test.cpp').read_text()), ('profile-and-transport', extra)]:
        test_source = directory / (name + '.cpp')
        binary = directory / name
        test_source.write_text(code)
        subprocess.run(['c++', '-std=c++14', '-pthread', '-Wall', '-Wextra', '-Werror', *includes, str(test_source), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
print('PASS public cache authenticated source, patch order, paid-node exception and atomic/cancellable source contracts; tree=' + expected)
