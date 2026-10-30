#!/usr/bin/env bash
# Read-only unless --crash-restart-probe is explicitly supplied. No test push.
set -euo pipefail
exec python3 - "$@" <<'PYTHON'
import argparse,datetime,json,os,pathlib,signal,subprocess,time
p=argparse.ArgumentParser(description='Inspect the installed per-user notification agent without reading credentials.')
p.add_argument('--config',required=True,type=pathlib.Path)
p.add_argument('--crash-restart-probe',action='store_true')
a=p.parse_args(); config=a.config.resolve(strict=True)
service='monero-fast-walletd.service'; directory=config.parent
health_path=directory/'agent-health.json'
def ctl(*args):return subprocess.run(['systemctl','--user',*args],capture_output=True,text=True,check=True).stdout.strip()
def health():
    try:
        if health_path.stat().st_size>4096:raise RuntimeError('Agent health exceeds its limit')
        return json.loads(health_path.read_text())
    except FileNotFoundError:return None
def verified(h):
    if not h or h.get('version')!=1 or not isinstance(h.get('pid'),int):return False
    instance=h.get('instanceId','')
    if len(instance)!=32 or any(c not in '0123456789abcdef' for c in instance):return False
    age=time.time()-h.get('heartbeatAt',0)
    if not 0<=age<=10:return False
    pid=h['pid']; proc=pathlib.Path('/proc')/str(pid)
    try:
        if proc.stat().st_uid!=os.getuid():return False
        exe=(proc/'exe').resolve(strict=True)
        exe.relative_to(directory.parent/'notification-runtime')
        return exe.name=='monero-fast-walletd' and int(ctl('show',service,'--property=MainPID','--value'))==pid
    except (OSError,ValueError,subprocess.CalledProcessError):return False
try:
    cfg=json.loads(config.read_text())
    fragment=pathlib.Path(ctl('show',service,'--property=FragmentPath','--value'))
    if 'com.tex8.monerowallet.desktop.notification-agent.v1' not in fragment.read_text():raise RuntimeError('User service is not managed by this application')
    initial=health(); fresh=verified(initial); recovered=None
    if a.crash_restart_probe:
        if not cfg.get('enabled') or not fresh:raise RuntimeError('Crash probe needs an enabled, verified own helper')
        # Exact service PID, UID and stable executable path were verified.
        if not verified(initial):raise RuntimeError('Helper process changed before the crash probe')
        os.kill(initial['pid'],signal.SIGKILL)
        until=time.monotonic()+40
        while time.monotonic()<until:
            time.sleep(.25); new=health()
            if verified(new) and new.get('instanceId')!=initial['instanceId']:recovered=True;break
        if not recovered:raise RuntimeError('User service did not recover within40s')
    h=health();fresh=verified(h); runtime_ok=False
    if fresh:
        exe=(pathlib.Path('/proc')/str(h['pid'])/'exe').resolve(strict=True)
        environment=dict(os.environ);environment.pop('LD_PRELOAD',None);environment.pop('LD_AUDIT',None)
        environment['LD_LIBRARY_PATH']=str(exe.parent.parent/'lib')
        r=subprocess.run(['ldd','-r',str(exe)],capture_output=True,text=True,env=environment)
        runtime_ok=r.returncode==0 and 'not found' not in r.stdout+r.stderr and 'undefined symbol:' not in r.stdout+r.stderr
    peer_age=time.time()-(h.get('lastPeerAt') or 0) if h else 999999
    print(json.dumps({'serviceOwned':True,'serviceActive':ctl('is-active',service)=='active','helperFreshAndPathVerified':fresh,
      'connected':bool(fresh and h.get('connected') is True and 0<=peer_age<=60),'phase':h.get('phase') if h else 'unknown',
      'osPhase':h.get('osPhase') if h else None,'installedRuntimeLddVerified':runtime_ok,'crashRecoveryVerified':recovered,'bannerPresentationVerified':False},indent=2))
    if not fresh or not runtime_ok:raise SystemExit(2)
except (OSError,ValueError,RuntimeError,subprocess.CalledProcessError) as error:
    print(json.dumps({'error':str(error),'credentialsRead':False}));raise SystemExit(1)
PYTHON
