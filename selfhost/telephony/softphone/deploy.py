"""Run on the existing server; never prints service credentials."""
import json
import ipaddress
import os
import pathlib
import subprocess

ROOT = pathlib.Path('/opt/smart-cs-softphone')
NAME = 'smart-cs-softphone'
IMAGE = 'smart-cs-softphone:20261116'


def deploy(replace=False):
    private_addresses = {}
    for key in ['SOFTPHONE_SERVER_IP', 'SOFTPHONE_CLIENT_IP']:
        value = os.environ.get(key, '').strip()
        try:
            address = ipaddress.IPv4Address(value)
        except ipaddress.AddressValueError:
            raise SystemExit('Set ' + key + ' to your own Tailscale IPv4 address')
        if address not in ipaddress.IPv4Network('100.64.0.0/10'):
            raise SystemExit(key + ' must be a Tailscale IPv4 address')
        private_addresses[key] = str(address)
    existing = subprocess.check_output(
        ['docker', 'ps', '-aq', '--filter', 'name=^' + NAME + '$']
    ).decode().strip()
    if existing and not replace:
        raise SystemExit('Existing test service found; use manage.py redeploy')

    data = ROOT / 'data'
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = json.loads(subprocess.check_output(['docker', 'inspect', 'smart-cs-app']))[0]
    env = dict(item.split('=', 1) for item in info['Config']['Env'])
    asr = json.loads(subprocess.check_output(['docker', 'inspect', 'smart-cs-asr']))[0]
    networks = asr['NetworkSettings']['Networks'].values()
    asr_ip = next(n['IPAddress'] for n in networks if n.get('IPAddress'))
    env['ASR_URL'] = 'http://' + asr_ip + ':8000'
    env['TTS_URL'] = 'http://127.0.0.1:28852'
    env['LLM_BASE'] = env.get('LLM_BASE', '').replace('host.docker.internal', '127.0.0.1')
    # Dedicated test-call model; keep the web app's independent model setting.
    env['LLM_MODEL_TELEPHONE'] = os.environ.get('LLM_MODEL_TELEPHONE') or env.get('LLM_MODEL_TELEPHONE') or env.get('LLM_MODEL', '')
    keys = ['LLM_BASE', 'LLM_KEY', 'LLM_MODEL', 'LLM_MODEL_VOICE', 'ASR_URL',
            'TTS_URL', 'FOLLOWUP_VOICE', 'FOLLOWUP_VOICE_SPEED', 'LLM_MODEL_TELEPHONE']
    values = []
    for key in keys:
        value = env.get(key, '')
        if value:
            if '\n' in value or '\r' in value:
                raise ValueError('Invalid environment value for ' + key)
            values.append(key + '=' + value)
    values += [key + '=' + value for key, value in private_addresses.items()]

    extra_mounts = []
    public_file = data / 'public-phone.json'
    if public_file.exists():
        public = json.loads(public_file.read_text())
        certificate_dir = pathlib.Path(public['certificateDir']).resolve(strict=True)
        if not certificate_dir.is_relative_to(pathlib.Path('/opt/1panel/www/sites')):
            raise ValueError('Unexpected certificate directory')
        for filename in ['fullchain.pem', 'privkey.pem']:
            if not (certificate_dir / filename).is_file():
                raise ValueError('Missing TLS file: ' + filename)
        extra_mounts = ['-v', str(certificate_dir) + ':/tls:ro']

    # Build successfully before interrupting the running test service.
    subprocess.run(['docker', 'build', '-f', 'telephony/softphone/Dockerfile',
                    '-t', IMAGE, '.'], cwd=ROOT, check=True)
    target = data / 'services.env'
    candidate = data / 'services.env.next'
    with os.fdopen(os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        f.write('\n'.join(values) + '\n')
    candidate.chmod(0o600)
    candidate.replace(target)
    if existing:
        subprocess.run(['docker', 'stop', NAME], check=True)
        subprocess.run(['docker', 'rm', NAME], check=True)
    # Host networking preserves the authenticated client's tailnet source IP.
    # service.cjs binds SIP/RTP to the tailnet IP and controls to loopback.
    subprocess.run(['docker', 'run', '-d', '--name', NAME, '--restart', 'unless-stopped',
                    '--network', 'host', '--cpus=1', '--memory=1g', '--pids-limit=200',
                    '--env-file', str(target), '-v', str(data) + ':/data', *extra_mounts, IMAGE], check=True)
    print('Private softphone test deployed')


if __name__ == '__main__':
    deploy()
