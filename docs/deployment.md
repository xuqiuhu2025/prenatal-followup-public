# 部署与配置

本文用于自行部署公开源码。所有域名、地址与凭据均由部署者填写；仓库没有公共演示服务或可共用的管理员账号。

## 主应用

1. 安装 Docker Engine 和 Compose 插件。准备一个 OpenAI 兼容模型网关，其接口为 /v1/chat/completions。
2. 复制 selfhost/.env.example 为 selfhost/.env。设置 PG_PASSWORD、ADMIN_PASSWORD、LLM_BASE、LLM_KEY 和 LLM_MODEL。LLM_BASE 不含末尾 /v1；模型名称必须与自己的网关一致。数据库密码会用于连接字符串，请使用足够长的随机字母数字串，或相应调整连接配置以正确转义。
3. ASR 使用 Sherpa-ONNX Paraformer。自行获取兼容且允许使用的模型，将 model.int8.onnx 和 tokens.txt 放在 selfhost/models/asr-model/。模型文件不随仓库提供。
4. 在宿主机安装 Node.js，运行 npm install --prefix selfhost/tts-proxy，然后用 Node 启动 selfhost/tts-proxy/tts_proxy.js。默认端口 28852，应用通过 host.docker.internal 访问；配置防火墙仅允许应用访问。音色代理通过 msedge-tts 调用外部语音服务，需按自己的运行环境验证连通性与服务条款。
5. 在 selfhost/ 运行 docker compose up -d --build。首次启动数据库执行 init/ 下的建表脚本，应用启动时补充幂等迁移。
6. 在自己的服务器使用 HTTPS 端口 28849 打开 /admin.html，用户名 admin，初始密码取 ADMIN_PASSWORD。Compose 会生成自签证书供本机测试；公网使用自己的域名与可信证书或 HTTPS 反向代理。

现有账号库不会被环境变量重置密码。修改密码通过账号页面完成。初始密码须为 8–128 位；配置模板中的占位文字必须替换。

ASR 模型或 TTS 服务缺失时语音不可用。文本、模型与语音链路需分别验证，不要将容器已启动当作完整业务就绪。

## 电话与测试分机

主应用默认 TELEPHONY_ENABLED=0。接入医院认可的 SIP 线路时，根据 selfhost/telephony/.env.telephony.example 和 Asterisk 配置模板填写自己的参数；只使用授权的测试号码进行联调。

不接运营商时可建立 [Linphone 测试分机](../selfhost/telephony/softphone/README.md)，验证机器人拨入、回拨、识别与播报。这仍是网络分机之间的通话。

## 数据与备份

PostgreSQL 数据、ASR 模型、真实 .env、录音、分机账号和证书均独立保存，不属于代码仓库。自行设置访问权限和备份周期。不要把数据卷导出、患者表格、配置二维码或日志提交到 Git。

归档 CloudBase 前端 webapp/js/config.js 的环境 ID 是占位符，只有自行填写并部署对应云函数后才可使用，与当前 selfhost/ 医院版不同。
