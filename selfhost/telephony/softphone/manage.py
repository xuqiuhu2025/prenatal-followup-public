import subprocess,sys,json,pathlib,urllib.request,urllib.parse
root=pathlib.Path('/opt/smart-cs-softphone')
action=sys.argv[1]
if action=='status':
    print(urllib.request.urlopen('http://127.0.0.1:9095/status',timeout=5).read().decode())
    subprocess.run(['docker','exec','smart-cs-softphone','asterisk','-C','/data/asterisk/etc/asterisk.conf','-rx','pjsip show contacts'],check=True)
elif action=='calls':
    rows=json.load(urllib.request.urlopen('http://127.0.0.1:9095/calls',timeout=5))
    print(json.dumps(rows,ensure_ascii=False))
elif action in ['dial','stop','provision']:
    url='http://127.0.0.1:9095/'+action
    if action in ['dial','provision']:url+='?'+urllib.parse.urlencode({'extension':sys.argv[2]})
    print(urllib.request.urlopen(urllib.request.Request(url,method='POST'),timeout=8).read().decode())
elif action in ['redeploy','repair-host-network']:
    status=json.load(urllib.request.urlopen('http://127.0.0.1:9095/status',timeout=5))
    if status['active']:
        raise SystemExit('A test call is active; finish it before redeploying')
    from deploy import deploy
    deploy(replace=True)
else:raise SystemExit('Unknown command')
