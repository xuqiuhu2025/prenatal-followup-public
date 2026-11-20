# 产前筛查与诊断随访系统

面向产前筛查与产前诊断一体化中心的中文随访工作台，包含孕次档案、Excel / CSV 导入、随访计划、账号管理和 AI 语音随访机器人。

[公开源码](https://github.com/xuqiuhu2025/prenatal-followup-public) · [业务流程](docs/prenatal-workflow.md) · [电话机器人](docs/telephone-followup.md) · [部署说明](docs/deployment.md)

## 功能

- 患者与孕次档案：按病案号和孕次编号管理，支持多胎、筛查报告、诊断结果、转诊与结局追踪。
- 表格导入：支持 XLSX、XLS、UTF-8 / GB18030 CSV，提供字段映射、预览、格式校验和去重。
- 随访计划：涵盖筛查告知、咨询转诊、介入术后、诊断结果、妊娠结局和出生后随访。
- 账号管理：管理员与医护角色，支持启停账号、修改密码、会话撤销及操作审计。
- 语音机器人：文字与录音对话、多轮上下文、口语化追问、更正记录、语音播报和待核实草稿。
- 电话接入：Asterisk AMI + AudioSocket，支持语音端点检测、插话停止播放和审核队列；Linphone 测试分机支持拨入和回拨。

一键拨号通过设备电话应用发起。拨打普通手机号码需要自行接入获准的 SIP / 运营商线路；源码不附带线路、号码或模型服务账号。AI 草稿供医护核实，不自动替代临床判断或完成随访任务。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| selfhost/webapp/ | 当前医院随访网页 |
| selfhost/server/ | Express API、账号、随访、对话和电话逻辑 |
| selfhost/init/ | PostgreSQL 建表与迁移脚本 |
| selfhost/asr/ | Sherpa-ONNX 中文语音识别服务 |
| selfhost/tts-proxy/ | 语音合成代理与音色配置 |
| selfhost/telephony/ | Asterisk 配置模板与独立测试分机 |
| selfhost/tests/ | 单元测试、隔离数据库及浏览器测试 |
| docs/ | 业务、部署、测试与虚构导入示例 |
| cloudfunctions/、webapp/、database/ | 归档的 CloudBase 客服实现，当前医院版使用 selfhost/ |

## 部署起点

使用 Docker Compose、PostgreSQL 16 和自行配置的 OpenAI 兼容模型网关。准备 ASR 模型文件与宿主机 TTS 代理后启动；具体步骤见 [部署说明](docs/deployment.md)。

将 selfhost/.env.example 复制为 selfhost/.env，填写自己的数据库密码、管理员初始密码、模型网关和模型名称。管理员用户名初始为 admin，**没有内置默认密码**；已有账号库重启不会重置密码。

部署后由自己的服务地址进入 /admin.html；麦克风需要 HTTPS。公网部署应使用自己的域名和可信证书。电话功能默认关闭。

## 本地验证

使用 Node.js 22 或更新版本，在仓库根目录运行：

    npm ci --prefix selfhost/server --ignore-scripts --no-audit --no-fund
    node --test selfhost/tests/*.test.cjs
    node docs/validate-prenatal-demo.cjs

单元测试使用本地模拟接口和隔离数据库。集成、浏览器及实际语音服务测试需另行配置测试环境，部分历史脚本还需要自行生成测试夹具。请先阅读脚本中的环境变量与独立数据库限制；公开版不包含私人验收录音或生产环境验收脚本。

## 示例与公开范围

[演示导入表](docs/prenatal-followup-fictional-demo.csv) 为独立构造的虚构数据。DEMO- 病案在页面上禁止拨号，格式合规的示例号码不代表不可达。声音样本为通用话术的合成音频。

此仓库从清理后的源码建立新历史，不含真实部署配置、患者数据库、通话记录、分机凭据或配置二维码。发布与备份说明见 [公开版本说明](docs/public-release.md) 和 [Git 使用说明](docs/github-backup.md)。

本项目尚未指定整体开源许可证。已保留第三方 SheetJS 的 Apache-2.0 许可证及来源说明；第三方代码与服务分别受其自身条款约束。
