# Linphone 随访测试分机

独立的 Asterisk 网络电话测试服务，复用主应用的对话与语音代码，支持模拟产后随访。没有运营商号码路由，测试草稿保存在自己的数据卷，不写正式患者库。

## 号码

| 号码 | 用途 |
| --- | --- |
| 6001 / 6002 | 私网客户端 / 自动测试分机 |
| 6003 / 6004 | 公网 TLS/SRTP 客户端 / 自动测试分机 |
| 7000 | 拨入随访机器人 |
| 7001 | 请求约 3 秒后回拨当前分机 |
| 6999 | 回声测试 |

## 部署前提

部署脚本面向 Linux Docker、已有 smart-cs-app 与 smart-cs-asr 容器以及宿主机 TTS 服务。将 selfhost/ 的内容放入自己服务器的 /opt/smart-cs-softphone/，保持 server/、init/、telephony/ 等相对结构。构建基础镜像：

    docker build -f telephony/lab/Dockerfile -t smart-cs-telephone-lab:20261116 .

脚本从现有应用容器读取模型与语音参数，写入权限为 0600 的 data/services.env。首次生成随机分机密码。目录、镜像名和容器名是脚本约定，如有冲突请先调整。

## 私网配置

在服务器环境中显式设置 SOFTPHONE_SERVER_IP 为自己的 Tailscale 地址，SOFTPHONE_CLIENT_IP 为获准测试客户端的 Tailscale 地址。地址必须在 100.64.0.0/10 内；仓库不提供可用地址。

可选设置 LLM_MODEL_TELEPHONE 为自己网关支持的电话模型，否则继承主应用 LLM_MODEL。然后运行：

    python3 telephony/softphone/deploy.py

私网 SIP TCP 5096 绑定服务器 Tailscale 地址，使用客户端 IP 白名单。AMI、AudioSocket 和 HTTP 管理端口监听回环地址。

## 公网手机配置

enable-public.py 是面向 1Panel / OpenResty / UFW 的可选启用脚本，会修改自己的测试服务、反向代理配置和防火墙。运行前准备域名、TLS 证书并设置：

- SOFTPHONE_PUBLIC_HOST：自己的 SIP 域名。
- SOFTPHONE_PUBLIC_IP：自己的公网 IPv4。
- SOFTPHONE_BIND_IP：服务器上实际可绑定的接口 IPv4。
- SOFTPHONE_NGINX_CONTAINER：自己的 OpenResty 容器名。
- SOFTPHONE_NETWORK_INTERFACE：自己的公网网卡名。
- SOFTPHONE_SERVER_IP / SOFTPHONE_CLIENT_IP：上述私网地址，启用和重建时仍然需要。

该脚本使用 /opt/1panel/www/sites/<域名>/ssl/ 下的 fullchain.pem 和 privkey.pem，只读挂载证书。其他部署布局应先调整脚本。SIP TLS 端口 28861，SRTP UDP 端口 18160–18180。HTTPS 仅代理 /followup-setup/ 配置下载路径，管理接口保持本机访问。

启用后运行 manage.py provision 6003 生成限时 HTTPS 配置链接，再导入自己的 Linphone。链接包含分机配置权限，应保存在私有位置。手机端使用自己的服务器账号，无需注册第三方 SIP 账号；iOS 未配置后台推送时应保持 App 在前台。

## 操作与验证

在服务器运行 python3 telephony/softphone/manage.py status 查看状态，calls 查看测试草稿，stop 结束当前通话。dial 6001 或 dial 6003 会直接拨打相应测试客户端，仅对获准设备使用。redeploy 更新容器，需再次提供私网地址环境变量，有活动通话时拒绝重建。

softphone-config.test.cjs 在本地验证消息分帧、TLS/TCP 与 NAT 转换、私网 ACL、SRTP 和配置链接过期。实际语音验收需自行准备虚构音频、客户端和服务，不包含私人分机配置或验收录音。
