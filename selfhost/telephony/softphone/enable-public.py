"""Enable the authorized public test extension on this existing server."""
import datetime
import json
import ipaddress
import os
import pathlib
import re
import shutil
import subprocess
import urllib.request

ROOT = pathlib.Path('/opt/smart-cs-softphone')
def required(name):
    value = os.environ.get(name, '').strip()
    if not value or '\n' in value or '\r' in value:
        raise SystemExit('Set ' + name + ' for your own server before running this script')
    return value

HOST = required('SOFTPHONE_PUBLIC_HOST')
NGINX = required('SOFTPHONE_NGINX_CONTAINER')
INTERFACE = required('SOFTPHONE_NETWORK_INTERFACE')
if not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z0-9]+', HOST):
    raise SystemExit('SOFTPHONE_PUBLIC_HOST must be a DNS hostname')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', NGINX) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]*', INTERFACE):
    raise SystemExit('Invalid container or network interface name')
for key in ['SOFTPHONE_SERVER_IP', 'SOFTPHONE_CLIENT_IP']:
    if ipaddress.IPv4Address(required(key)) not in ipaddress.IPv4Network('100.64.0.0/10'):
        raise SystemExit(key + ' must be a Tailscale IPv4 address')
settings = {
    'host': HOST, 'address': str(ipaddress.IPv4Address(required('SOFTPHONE_PUBLIC_IP'))),
    'bindAddress': str(ipaddress.IPv4Address(required('SOFTPHONE_BIND_IP'))),
    'port': 28861, 'certificateDir': '/opt/1panel/www/sites/' + HOST + '/ssl'
}
status = json.load(urllib.request.urlopen('http://127.0.0.1:9095/status', timeout=5))
if status['active']:
    raise SystemExit('A test call is active; finish it before enabling public phones')

backup = ROOT / ('backups/public-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(mode=0o700, parents=True)
for name in ['credentials.json', 'public-phone.json']:
    if (ROOT/'data'/name).exists():
        shutil.copy2(ROOT/'data'/name, backup/name)
target = ROOT/'data/public-phone.json'
with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as file:
    json.dump(settings, file)

from deploy import deploy
deploy(replace=True)

# Expose only the tokenized setup document, never the controller endpoints.
location = pathlib.Path('/opt/1panel/www/sites') / HOST / 'proxy/followup-setup.conf'
if location.exists():
    shutil.copy2(location, backup/'followup-setup.conf')
nginx_conf = '''location ^~ /followup-setup/ {
    limit_except GET HEAD { deny all; }
    proxy_pass http://127.0.0.1:9095;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_cache off;
    proxy_buffering off;
    access_log off;
    add_header Cache-Control "no-store" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
}
'''
location.write_text(nginx_conf)
check = subprocess.run(['docker', 'exec', NGINX, 'openresty', '-t'], capture_output=True)
if check.returncode:
    if (backup/'followup-setup.conf').exists():
        shutil.copy2(backup/'followup-setup.conf', location)
    else:
        location.unlink()
    raise SystemExit('Nginx configuration check failed; setup route rolled back')
subprocess.run(['docker', 'exec', NGINX, 'openresty', '-s', 'reload'], check=True, capture_output=True)

subprocess.run(['ufw', 'limit', 'in', 'on', INTERFACE, 'proto', 'tcp', 'to', settings['bindAddress'], 'port', str(settings['port']), 'comment', 'followup SIP TLS test'], check=True)
subprocess.run(['ufw', 'allow', 'in', 'on', INTERFACE, 'proto', 'udp', 'to', settings['bindAddress'], 'port', '18160:18180', 'comment', 'followup SRTP test'], check=True)
print(json.dumps({'host': HOST, 'sipTlsPort': settings['port'], 'mobileExtension': '6003', 'qaExtension': '6004'}))
