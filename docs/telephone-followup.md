# 自研随访机器人与电话接入

医院工作台入口是自己部署的 /admin.html#calling。机器人通过项目内的对话编排调用语言模型、语音识别和语音合成服务。

## 对话与随访

网页支持固定问卷和智能对话。智能对话覆盖筛查结果告知、转诊、介入术后一周、诊断结果告知、妊娠结局、出生后随访和补充反馈；按胎儿分别记录，保留原文和更正。

首次先确认本人或授权家属以及是否方便继续。产后先问妈妈恢复，再问宝宝近况和后续检查；回答包含多项信息时只追问缺漏内容。记录不清楚的内容留给医护核实，不把未提及当作正常。

例如受访者回答“两个月，吃睡都还好”，机器人记录月龄和近况，再询问儿保情况；受访者纠正月份时保留更正前后的原话。用户要求结束或人工协助时停止问卷并标记待处理；当前不支持实时转接人工坐席。

模型输出必须匹配预设字段，引用来自受访者原话。AI 草稿始终标记待核实，试玩不会写入正式患者档案或自动完成临床任务。文本及语音识别结果会发送到自己配置的模型服务。

## 语音链路

ASR 使用 Sherpa-ONNX，TTS 通过 msedge-tts 代理提供晓晓、晓伊和云希音色。声音样本见 [合成音频示例](voice-samples/index.html)。这些样本是通用话术，不是患者录音。

网页模型由 LLM_MODEL / LLM_MODEL_VOICE 配置。独立电话测试服务可通过 LLM_MODEL_TELEPHONE 指定网关内可用的模型；部署脚本默认继承主应用配置。源码包含 DeepSeek V4.1 Flash 的电话参数适配，但不附带该模型或调用额度。

电话支持提前识别、常见问句预热、校验后分句合成、静音裁剪和插话取消；复杂回答仍受模型服务与网络速度影响，源码不保证固定响应延迟。配置和原理见 [流畅度说明](telephone-fluency.md)。

## 一键拨号与自动电话

一键拨号唤起设备电话应用，网页无法判断是否接通。AI 自动电话通过 Asterisk AMI 发起呼叫，AudioSocket 传输双向 PCM 音频。普通手机号码需要自己申请和配置获准 SIP / 运营商线路。

主应用的真实外呼默认关闭。启用前配置 selfhost/telephony/.env.telephony.example、extensions.conf.example、manager.conf.example 和 pjsip-endpoint.example.conf；这些仅是模板，不能直接代替服务商参数。

AMI 与 AudioSocket 应通过受限网络连接，设置 Manager ACL 与 TELEPHONY_MEDIA_PEERS。后台只允许已配置号码，并限制时段、频率和并发；拒访后进入抑制清单。通话状态依据实际电话事件记录，拨号受理不等于接通。挂断后保存待医护审核的草稿，不自动完成临床随访。

没有运营商线路时，可使用 [独立 Linphone 测试分机](../selfhost/telephony/softphone/README.md) 进行模拟产后电话，测试数据与正式患者库分离。公网手机测试采用 TLS/SRTP；当前未实现 iOS VoIP 推送，需保持客户端在前台。

## 验证

telephony.test.cjs 使用本机模拟 AMI、PCM 和 PostgreSQL 兼容内存数据库覆盖拨号、频控、拒访、通话保存与审核。telephone-fluency.test.cjs 验证提前识别、分句播放与取消。softphone-config.test.cjs 验证 SIP 消息分帧、地址改写、ACL 和配置链接过期。

真实 Asterisk 验证脚本为 selfhost/tests/telephony-asterisk.cjs，需先准备独立容器实验环境及虚构语音夹具。浏览器和实际服务测试应指向自己的测试环境；私人生产验收脚本和录音未收录。

## 参考

- [Asterisk AudioSocket](https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/)
- [Asterisk AMI Originate](https://docs.asterisk.org/Latest_API/API_Documentation/AMI_Actions/Originate/)
- [Linphone 远程配置格式](https://wiki.linphone.org/xwiki/wiki/public/view/Linphone/Remote%20Provisioning/)
